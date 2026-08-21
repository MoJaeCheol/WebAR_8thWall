/**
 * 로컬 개발 서버
 *  - HTTP  : PC 브라우저 테스트용 (localhost 는 secure context 라 카메라 허용됨)
 *  - HTTPS : 스마트폰 실기기 테스트용 (LAN IP 접속 시 https 필수)
 *  - /api/immersal/* : Immersal REST 프록시 (CORS 회피 + 토큰을 클라이언트에 노출하지 않기 위함)
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');

// Render 등 PaaS 는 TLS 를 앞단에서 끝내주므로 프로덕션에서는 HTTP 만 띄운다.
const IS_PROD = Boolean(process.env.RENDER || process.env.NODE_ENV === 'production');
const PORT = Number(process.env.PORT || 3000);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
// 배포마다 바뀌는 값. 정적 자산 URL 에 붙여 브라우저 캐시를 확실히 무효화한다.
// (Cache-Control 만으로는 이미 캐시된 응답을 되돌릴 수 없다)
const BUILD_ID = Date.now().toString(36);

const CERT_DIR = path.join(__dirname, 'certs');
const KEY_FILE = path.join(CERT_DIR, 'dev-key.pem');
const CRT_FILE = path.join(CERT_DIR, 'dev-cert.pem');

// --- .env 아주 단순 로더 (의존성 없이) ---
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

// --- LAN IPv4 주소 수집 ---
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// --- 자체 서명 인증서 자동 생성 (openssl 필요, Git for Windows 에 포함되어 있음) ---
function ensureCert() {
  if (fs.existsSync(KEY_FILE) && fs.existsSync(CRT_FILE)) return true;
  fs.mkdirSync(CERT_DIR, { recursive: true });

  const sans = ['DNS:localhost', 'IP:127.0.0.1', ...lanAddresses().map((ip) => `IP:${ip}`)];
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-days', '825',
      '-keyout', KEY_FILE,
      '-out', CRT_FILE,
      '-subj', '/CN=ar-8th-dev',
      '-addext', `subjectAltName=${sans.join(',')}`,
    ], { stdio: 'pipe' });
    console.log(`[cert] 자체 서명 인증서 생성 완료 → ${CERT_DIR}`);
    console.log(`[cert] SAN: ${sans.join(', ')}`);
    return true;
  } catch (e) {
    console.warn('[cert] openssl 실행 실패 — HTTPS 없이 HTTP 로만 기동합니다.');
    console.warn('[cert] ' + (e.stderr ? e.stderr.toString().trim() : e.message));
    return false;
  }
}

const app = express();
app.use(express.json({ limit: '12mb' })); // base64 이미지 업로드용

/**
 * index.html 은 정적 서빙 대신 여기서 처리한다.
 * css/js 경로에 ?v=BUILD_ID 를 붙여, 배포가 바뀌면 브라우저가 반드시 새로 받게 한다.
 */
function sendIndex(req, res) {
  try {
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    html = html.replace(/(src|href)="((?:css|js)\/[^"?]+)"/g, `$1="$2?v=${BUILD_ID}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(html);
  } catch (e) {
    res.status(500).send('index.html 을 읽을 수 없습니다: ' + e.message);
  }
}
app.get('/', sendIndex);
app.get('/index.html', sendIndex);

app.use(express.static(path.join(__dirname, 'public'), {
  index: false,   // index.html 은 위 핸들러가 담당
  // 개발 중에는 캐시를 끄고, 프로덕션에서는 8frame(1.4MB) 등이 재다운로드되지 않게 캐싱한다.
  etag: true,
  maxAge: 0,
  setHeaders(res, filePath) {
    const rel = filePath.split(path.sep).join('/');
    if (rel.includes('/external/')) {
      // 버전이 파일명에 박힌 벤더 스크립트만 장기 캐시
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    } else if (IS_PROD) {
      // 앱 파일은 항상 재검증. 캐시로 두면 고친 코드가 폰에 안 내려간다(304 라 비용도 거의 없다).
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

// ── 자체 VPS (Python FastAPI, 127.0.0.1:8000) ─────────────────
// 폰은 이 Node 서버(HTTPS)에만 붙고, 여기서 로컬 Python 으로 중계한다.
// 단일 오리진이라 CORS 불필요, Python 쪽 TLS 불필요.
const VPS_URL = process.env.VPS_URL || 'http://127.0.0.1:8000';
let vpsProbe = { at: 0, ok: false, maps: [] };

async function probeVps() {
  // 성공은 10초 캐시, 실패는 3초만 — 측위 서버가 부팅 중일 때 빨리 복구되도록
  const ttl = vpsProbe.ok ? 10_000 : 3_000;
  if (Date.now() - vpsProbe.at < ttl) return vpsProbe;
  try {
    const r = await fetch(`${VPS_URL}/health`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    vpsProbe = { at: Date.now(), ok: Boolean(j.ok), maps: j.maps || [] };
  } catch (e) {
    vpsProbe = { at: Date.now(), ok: false, maps: [] };
  }
  return vpsProbe;
}

/**
 * 클라이언트가 서버 설정을 알 수 있게 하는 엔드포인트.
 * 토큰 자체는 내려보내지 않고 "설정 여부"만 알려준다.
 */
app.get('/api/config', async (req, res) => {
  const vps = await probeVps();
  res.json({
    buildId: BUILD_ID,
    immersalConfigured: Boolean(process.env.IMMERSAL_TOKEN && process.env.IMMERSAL_MAP_IDS),
    mapIds: (process.env.IMMERSAL_MAP_IDS || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter(Boolean),
    vps: { configured: vps.ok, mapIds: vps.maps },
  });
});

/** 자체 VPS 측위 프록시. 요청 형식은 Immersal 프록시와 동일 {b64, fx, fy, ox, oy}. */
app.post('/api/vps/localize', async (req, res) => {
  const started = Date.now();
  try {
    const r = await fetch(`${VPS_URL}/localize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
    });
    const json = await r.json();
    console.log(`[vps] ${r.status} ${Date.now() - started}ms → ${JSON.stringify(json).slice(0, 200)}`);
    res.status(r.status).json(json);
  } catch (e) {
    console.error('[vps] 요청 실패:', e.message);
    res.status(502).json({ error: 'vps-unreachable', message: 'Python 측위 서버(:8000)가 떠 있는지 확인하세요. ' + e.message });
  }
});

/** 자체 맵 포인트클라우드 중계 (PLY — 기존 AR 오버레이 디버그 뷰가 그대로 쓴다). */
app.get('/api/vps/map/:mapId/pointcloud', async (req, res) => {
  const key = `vps:${req.params.mapId}`;
  if (pointCloudCache.has(key)) {
    return res.type('application/octet-stream').send(pointCloudCache.get(key));
  }
  try {
    const r = await fetch(`${VPS_URL}/map/${encodeURIComponent(req.params.mapId)}/pointcloud.ply`);
    if (!r.ok) return res.status(r.status).json({ error: 'upstream', status: r.status });
    const buf = Buffer.from(await r.arrayBuffer());
    pointCloudCache.set(key, buf);
    res.type('application/octet-stream').send(buf);
  } catch (e) {
    res.status(502).json({ error: 'vps-unreachable', message: e.message });
  }
});

/**
 * Immersal 측위 프록시.
 * 클라이언트는 { b64, fx, fy, ox, oy } 만 보낸다. 토큰/맵ID는 서버가 주입.
 * 응답은 Immersal 원본 JSON 을 그대로 전달.
 */
app.post('/api/immersal/localize', async (req, res) => {
  const token = process.env.IMMERSAL_TOKEN;
  const mapIds = (process.env.IMMERSAL_MAP_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean)
    .map((id) => ({ id }));

  if (!token || mapIds.length === 0) {
    return res.status(503).json({
      error: 'not-configured',
      message: '.env 에 IMMERSAL_TOKEN 과 IMMERSAL_MAP_IDS 를 설정하세요.',
    });
  }

  const { b64, fx, fy, ox, oy, qx, qy, qz, qw, solverType } = req.body || {};
  if (!b64 || !fx || !fy) {
    return res.status(400).json({ error: 'bad-request', message: 'b64, fx, fy 는 필수입니다.' });
  }

  const endpoint = process.env.IMMERSAL_ENDPOINT || 'https://api.immersal.com/localizeb64';
  const started = Date.now();
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token, mapIds, b64, fx, fy, ox, oy,
        // 기기 자세 prior (있을 때만). 공식 구현이 /localize 에 함께 보내는 값들이다.
        ...(solverType != null ? { qx, qy, qz, qw, solverType } : {}),
        param1: 0, param2: 12, param3: 1.0, param4: 2.0,
      }),
    });
    const json = await r.json();
    console.log(`[immersal] ${r.status} ${Date.now() - started}ms → ${JSON.stringify(json).slice(0, 200)}`);
    res.status(r.status).json(json);
  } catch (e) {
    console.error('[immersal] 요청 실패:', e.message);
    res.status(502).json({ error: 'upstream-failed', message: e.message });
  }
});

// ── 앵커(콘텐츠 배치 좌표) 저장소 ──────────────────────────────
// VPS 의 핵심은 "누가 언제 와도 같은 자리, 같은 각도" 다.
// 그러려면 배치 좌표가 기기가 아니라 서버에 있어야 한다.
const ANCHOR_FILE = path.join(__dirname, 'data', 'anchors.json');

function readAnchors() {
  try {
    return JSON.parse(fs.readFileSync(ANCHOR_FILE, 'utf8'));
  } catch (e) {
    return { anchors: {} };
  }
}

function writeAnchors(doc) {
  fs.mkdirSync(path.dirname(ANCHOR_FILE), { recursive: true });
  fs.writeFileSync(ANCHOR_FILE, JSON.stringify(doc, null, 2), 'utf8');
}

/** 특정 맵의 배치 좌표를 읽는다. 없으면 null. */
app.get('/api/anchor/:mapId', (req, res) => {
  const doc = readAnchors();
  const a = doc.anchors[String(req.params.mapId)];
  res.json(a ? { found: true, anchor: a } : { found: false, anchor: null });
});

// ── 맵 포인트 클라우드 중계 ────────────────────────────────
// 맵의 특징점을 AR 로 겹쳐 보면 맵 품질과 정렬을 눈으로 동시에 검증할 수 있다.
const pointCloudCache = new Map();

app.get('/api/map/:mapId/pointcloud', async (req, res) => {
  const token = process.env.IMMERSAL_TOKEN;
  if (!token) return res.status(503).json({error: 'not-configured'});

  const mapId = String(req.params.mapId);
  if (pointCloudCache.has(mapId)) {
    res.type('application/octet-stream');
    return res.send(pointCloudCache.get(mapId));
  }

  try {
    const url = `https://api.immersal.com/sparse?token=${encodeURIComponent(token)}&id=${encodeURIComponent(mapId)}`;
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).json({error: 'upstream', status: r.status});
    const buf = Buffer.from(await r.arrayBuffer());
    pointCloudCache.set(mapId, buf);
    console.log(`[map] ${mapId} 포인트클라우드 ${buf.length} bytes 캐시됨`);
    res.type('application/octet-stream').send(buf);
  } catch (e) {
    console.error('[map] 포인트클라우드 실패:', e.message);
    res.status(502).json({error: 'upstream-failed', message: e.message});
  }
});

/** 앵커 삭제 (개발자 모드에서 배치를 취소할 때) */
app.delete('/api/anchor/:mapId', (req, res) => {
  const doc = readAnchors();
  const mapId = String(req.params.mapId);
  const had = Boolean(doc.anchors[mapId]);
  delete doc.anchors[mapId];
  writeAnchors(doc);
  console.log(`[anchor] map ${mapId} 삭제됨 (있었나: ${had})`);
  res.json({ok: true, deleted: had});
});

/** 전체 앵커 덤프 — 재배포 후에도 유지하려면 이 내용을 data/anchors.json 에 커밋한다. */
app.get('/api/anchors', (req, res) => res.json(readAnchors()));

/** 배치 좌표를 저장한다 (저작 모드에서 호출). */
app.post('/api/anchor/:mapId', (req, res) => {
  const { position, rotationY } = req.body || {};
  if (!position || typeof position.x !== 'number') {
    return res.status(400).json({ error: 'bad-request', message: 'position {x,y,z} 가 필요합니다.' });
  }
  const doc = readAnchors();
  const mapId = String(req.params.mapId);
  doc.anchors[mapId] = {
    position: { x: +position.x, y: +position.y, z: +position.z },
    rotationY: +(rotationY || 0),
    updated: new Date().toISOString(),
  };
  writeAnchors(doc);
  console.log(`[anchor] map ${mapId} 저장:`, JSON.stringify(doc.anchors[mapId]));
  if (IS_PROD) {
    // Render 무료 플랜은 파일시스템이 휘발성이라 재배포 시 사라진다.
    // 영구 보존하려면 아래 내용을 data/anchors.json 에 커밋할 것.
    console.log('[anchor] ⚠ 영구 보존하려면 data/anchors.json 에 커밋:\n' + JSON.stringify(doc, null, 2));
  }
  res.json({ ok: true, anchor: doc.anchors[mapId] });
});

// --- 헬스체크 (Render 가 서비스 상태를 확인한다) ---
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// --- 기동 ---
if (IS_PROD) {
  // 프로덕션: 플랫폼이 넘겨주는 PORT 하나만 열고 TLS 는 플랫폼(Render)에 맡긴다.
  http.createServer(app).listen(PORT, '0.0.0.0', () => {
    console.log(`[prod] listening on 0.0.0.0:${PORT}`);
    console.log(`[prod] immersal ${process.env.IMMERSAL_TOKEN ? '설정됨' : '미설정'}`);
  });
} else {
  const certOnly = process.argv.includes('--cert-only');
  const hasCert = ensureCert();
  if (certOnly) process.exit(hasCert ? 0 : 1);

  http.createServer(app).listen(PORT, () => {
    console.log(`
  HTTP   -> http://localhost:${PORT}   (PC 테스트용)`);
  });

  if (hasCert) {
    const creds = { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CRT_FILE) };
    https.createServer(creds, app).listen(HTTPS_PORT, () => {
      console.log(`  HTTPS  -> https://localhost:${HTTPS_PORT}`);
      for (const ip of lanAddresses()) {
        console.log(`  폰 접속 -> https://${ip}:${HTTPS_PORT}   (인증서 경고는 "고급 → 계속" 선택)`);
      }
      console.log('');
    });
  }
}
