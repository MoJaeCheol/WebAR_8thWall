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

app.use(express.static(path.join(__dirname, 'public'), {
  // 개발 중에는 캐시를 끄고, 프로덕션에서는 8frame(1.4MB) 등이 재다운로드되지 않게 캐싱한다.
  etag: true,
  maxAge: IS_PROD ? '1h' : 0,
  setHeaders(res, filePath) {
    if (!IS_PROD) {
      res.setHeader('Cache-Control', 'no-store');
    } else if (/[\/]external[\/]/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable'); // 버전 고정된 벤더 스크립트
    }
  },
}));

/**
 * 클라이언트가 서버 설정을 알 수 있게 하는 엔드포인트.
 * 토큰 자체는 내려보내지 않고 "설정 여부"만 알려준다.
 */
app.get('/api/config', (req, res) => {
  res.json({
    immersalConfigured: Boolean(process.env.IMMERSAL_TOKEN && process.env.IMMERSAL_MAP_IDS),
    mapIds: (process.env.IMMERSAL_MAP_IDS || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter(Boolean),
  });
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

  const { b64, fx, fy, ox, oy } = req.body || {};
  if (!b64 || !fx || !fy) {
    return res.status(400).json({ error: 'bad-request', message: 'b64, fx, fy 는 필수입니다.' });
  }

  const endpoint = process.env.IMMERSAL_ENDPOINT || 'https://api.immersal.com/localizeb64';
  const started = Date.now();
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, mapIds, b64, fx, fy, ox, oy, param1: 0, param2: 12, param3: 1.0, param4: 2.0 }),
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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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
