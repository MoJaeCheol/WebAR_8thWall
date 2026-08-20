/**
 * 체험 전체 흐름 — 관람 모드 / 개발자 모드.
 *
 * 관람 모드 (기본)
 *   - 아무것도 배치하지 않는다. 개발자가 저장해 둔 위치가 있을 때만 그 자리에 세운다.
 *   - 바닥을 탭해도 반응하지 않는다. "누가 와도 같은 자리" 가 VPS 의 요점이기 때문이다.
 *
 * 개발자 모드 (우상단 ⚙)
 *   - 맵 검증: 특징점 겹쳐 보기, 측위 성공률, 스케일·일치오차 진단
 *   - 문 위치 지정: 바닥 탭으로 이동, 15도 단위 회전, 저장/삭제
 */
AFRAME.registerComponent('dora-experience', {
  init() {
    this.cfg = window.AR_CONFIG;
    this.count = 0;
    this.total = 0;
    this.door = null;
    this.doorYaw = 0;
    this.savedAnchor = null;
    this.localizedMapId = null;
    this.pointCloud = null;

    this.root = document.querySelector('#contentRoot');
    this.ground = document.querySelector('#ground');

    this.el.addEventListener('item-collected', (e) => this.onCollect(e.detail.type));
    this.root.addEventListener('immersal-localized', (e) => {
      const resp = e.detail && e.detail.response;
      this.localizedMapId = resp && resp.map;
      this.onLocalized(resp);
    });

    // 바닥 탭은 개발자 모드에서만 동작한다.
    this.ground.addEventListener('click', (e) => {
      if (!this.devMode) return;
      this.placeDoor(e.detail.intersection.point);
    });

    this.bindDevUI();
    this.setDevMode(localStorage.getItem('devMode') === '1');
    setInterval(() => this.updateDevReadout(), 300);

    this.el.addEventListener('realityready', () => {
      this.setTracking('ok', '트래킹 준비됨');
      this.setHint('주변을 천천히 비춰줘. 위치가 인식되면 문이 나타나');
      this.initImmersal();
    });
    this.el.addEventListener('xrtrackingstatus', (e) => {
      const s = e.detail && e.detail.status;
      if (s === 'NORMAL') this.setTracking('ok', '트래킹 정상');
      else if (s === 'LIMITED') this.setTracking('warn', '트래킹 불안정');
      else this.setTracking('pending', '트래킹 초기화 중');
    });
    this.el.addEventListener('realityerror', (e) => {
      this.setTracking('err', '카메라 오류');
      Log.error('[8thwall] realityerror', e.detail && e.detail.message);
    });
  },

  // ── 개발자 모드 ────────────────────────────────────────
  bindDevUI() {
    const $ = (s) => document.querySelector(s);
    $('#devBtn').addEventListener('click', () => this.setDevMode(!this.devMode));
    $('#devCollapse').addEventListener('click', () => {
      const c = document.body.classList.toggle('dev-collapsed');
      $('#devCollapse').textContent = c ? '▼' : '▲';
    });
    $('#devRotL').addEventListener('click', () => this.rotateDoor(-15));
    $('#devRotR').addEventListener('click', () => this.rotateDoor(15));
    $('#devSave').addEventListener('click', () => this.saveAnchor());
    $('#devDelete').addEventListener('click', () => this.deleteAnchor());
    $('#devTogglePoints').addEventListener('click', () => this.togglePointCloud());
    $('#devToggleLog').addEventListener('click', () => {
      const on = document.querySelector('#log').classList.toggle('on');
      $('#devToggleLog').classList.toggle('active', on);
      $('#devToggleLog').textContent = on ? '로그 닫기' : '로그 보기';
    });
    $('#devReport').addEventListener('click', () => this.copyReport());
    $('#devRuler').addEventListener('click', () => this.toggleRuler());
    $('#devScaleDown').addEventListener('click', () => this.nudgeSceneScale(1 / 1.1));
    $('#devScaleUp').addEventListener('click', () => this.nudgeSceneScale(1.1));
    $('#devScaleReset').addEventListener('click', () => this.nudgeSceneScale(null));
    $('#devAutoCal').addEventListener('click', () => {
      if (!this.localizer) return;
      const on = !this.localizer.autoCalibrate;
      this.localizer.autoCalibrate = on;
      $('#devAutoCal').classList.toggle('active', on);
      $('#devAutoCal').textContent = on ? '자동보정 켬' : '자동보정 끔';
      Log.info(`[dev] 초점거리 자동보정 ${on ? '켜짐' : '꺼짐'}`);
    });
    $('#devResetFocal').addEventListener('click', () => {
      if (this.localizer) this.localizer.resetFocal();
    });
    $('#devCycleConv').addEventListener('click', () => {
      if (!this.localizer) return;
      const name = this.localizer.setConvention(this.localizer.conventionIndex + 1);
      Log.info('[dev] 규약 수동 변경 →', name);
    });
  },

  setDevMode(on) {
    this.devMode = on;
    document.body.classList.toggle('dev-mode', on);
    localStorage.setItem('devMode', on ? '1' : '0');
    if (on) {
      this.setHint('개발자 모드 — 바닥을 탭해 문 위치를 정하고 저장하세요');
    } else {
      document.querySelector('#log').classList.remove('on');
      this.setHint(this.savedAnchor ? '문을 탭하면 열려' : '아직 문 위치가 지정되지 않았어');
    }
  },

  async togglePointCloud() {
    const btn = document.querySelector('#devTogglePoints');
    if (this.pointCloud) {
      const vis = !this.pointCloud.getAttribute('visible');
      this.pointCloud.setAttribute('visible', vis);
      btn.classList.toggle('active', vis);
      btn.textContent = vis ? '맵 특징점 숨기기' : '맵 특징점 겹쳐 보기';
      return;
    }
    if (!this.localizedMapId) { this.setHint('측위가 성공해야 맵을 겹쳐 볼 수 있어'); return; }

    btn.textContent = '불러오는 중…';
    try {
      const res = await fetch(`/api/map/${this.localizedMapId}/pointcloud`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const {count, positions, colors} = window.PLY.parse(await res.arrayBuffer());

      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      if (colors) geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.PointsMaterial({
        size: 0.03, sizeAttenuation: true,
        vertexColors: Boolean(colors), color: colors ? 0xffffff : 0x00e5ff,
      });

      const el = document.createElement('a-entity');
      this.root.appendChild(el);
      el.setObject3D('mesh', new THREE.Points(geom, mat));
      this.pointCloud = el;

      document.querySelector('#devPoints').textContent = `${count.toLocaleString()}개`;
      btn.classList.add('active');
      btn.textContent = '맵 특징점 숨기기';
      Log.info(`[map] 특징점 ${count}개 표시`);
      this.setHint('점들이 실제 공간과 겹쳐 보이면 맵과 정렬이 모두 정상이야');
    } catch (e) {
      btn.textContent = '맵 특징점 겹쳐 보기';
      Log.error('[map] 포인트클라우드 실패:', e.message);
    }
  },

  // ── Immersal ──────────────────────────────────────────
  async initImmersal() {
    const cfg = this.cfg.immersal;
    if (!cfg.enabled) { this.setVps('', 'VPS 꺼짐'); return; }
    if (typeof XR8 === 'undefined' || !XR8.CameraPixelArray) {
      this.setVps('err', 'VPS 사용 불가');
      Log.warn('[immersal] XR8.CameraPixelArray 없음');
      return;
    }

    const sceneScale = (this.el.getAttribute('xrweb') || {}).scale;
    Log.info(`[8thwall] scale = ${sceneScale}${sceneScale === 'absolute' ? ' (미터 단위)' : ' — absolute 여야 함'}`);

    this.localizer = new window.ImmersalLocalizer({
      rootEl: this.root,
      cameraEl: this.el.camera.el,
      onDiagnostics: (d) => this.showDiagnostics(d),
      onStatus: (s) => {
        const map = {
          idle: ['warn', 'VPS 대기'], pending: ['pending', 'VPS 측위 중'],
          ok: ['ok', 'VPS 정렬됨'], fail: ['warn', 'VPS 재시도'],
          disabled: ['', 'VPS 미설정'],
        };
        const [dot, text] = map[s] || ['', 'VPS'];
        this.setVps(dot, text);
      },
    });

    const conv = cfg.poseConvention;
    this.localizer.autoConvention = (conv === 'auto' || conv === undefined);
    this.localizer.conventionIndex = this.localizer.autoConvention ? 2 : conv;
    if (cfg.initialFovDeg) this.localizer.initialFovDeg = cfg.initialFovDeg;
    this.localizer.sendOrientationPrior = cfg.sendOrientationPrior === true;
    this.localizer.gravityLock = cfg.gravityLock !== false;
    if (cfg.smoothing !== undefined) this.localizer.smoothing = cfg.smoothing;
    if (cfg.outlierMeters !== undefined) this.localizer.outlierMeters = cfg.outlierMeters;
    this.localizer.autoCalibrate = cfg.autoCalibrate === true;
    this.localizer.autoSceneScale = cfg.autoSceneScale !== false;
    this.localizer.attachPipeline(cfg.maxDimension);

    const ready = await this.localizer.checkServer();
    if (ready && cfg.autoLocalize) {
      this.localizer.startAuto({
        intervalMs: cfg.intervalMs,
        maxAttempts: cfg.maxAttempts,
        continuous: cfg.continuous !== false,   // 진단에 두 지점 측위가 필요하다
      });
    }
  },

  /** 측위 성공 시. 저장된 위치가 있을 때만 배치한다. */
  async onLocalized(response) {
    const mapId = response && response.map;
    document.querySelector('#devMapId').textContent = mapId || '–';

    if (this.savedAnchor === null && mapId > 0) {
      try {
        const j = await (await fetch(`/api/anchor/${mapId}`)).json();
        this.savedAnchor = j.found ? j.anchor : false;
      } catch (e) {
        this.savedAnchor = false;
        Log.warn('[anchor] 조회 실패:', e.message);
      }
      this.updateAnchorLabel();
    }

    if (this.savedAnchor && !this.door) {
      const p = this.savedAnchor.position;
      this.placeDoorLocal(new THREE.Vector3(p.x, p.y, p.z),
                          (this.savedAnchor.rotationY || 0) * Math.PI / 180);
      this.setHint('문을 탭하면 열려');
      Log.info('[anchor] 저장된 위치에 배치');
    } else if (!this.savedAnchor && !this.devMode) {
      // 임의의 자리에 놓지 않는다. 위치는 개발자가 정하는 것이다.
      this.setHint('위치는 인식됐는데 아직 문 위치가 지정되지 않았어');
    }
  },

  // ── 배치 ──────────────────────────────────────────────
  /** 월드(트래킹) 좌표를 콘텐츠 루트의 로컬 좌표(=맵 좌표)로 변환해 배치한다. */
  placeDoor(worldPoint) {
    const root3D = this.root.object3D;
    root3D.updateMatrixWorld(true);
    const local = root3D.worldToLocal(new THREE.Vector3(worldPoint.x, worldPoint.y, worldPoint.z));

    const camWorld = new THREE.Vector3();
    this.el.camera.el.object3D.getWorldPosition(camWorld);
    const worldYaw = Math.atan2(camWorld.x - worldPoint.x, camWorld.z - worldPoint.z);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, worldYaw, 0));
    const rootQ = new THREE.Quaternion();
    root3D.getWorldQuaternion(rootQ);
    q.premultiply(rootQ.invert());

    this.placeDoorLocal(local, new THREE.Euler().setFromQuaternion(q, 'YXZ').y);
  },

  placeDoorLocal(local, yawRad) {
    const c = this.cfg.content;
    if (!this.door) {
      const door = document.createElement('a-entity');
      door.setAttribute('anywhere-door', {width: c.doorWidth, height: c.doorHeight});
      door.setAttribute('scale', '0.001 0.001 0.001');
      this.root.appendChild(door);
      door.setAttribute('animation__pop', {property: 'scale', to: '1 1 1', dur: 700, easing: 'easeOutElastic'});
      door.addEventListener('door-opened', () => this.setHint('문 안쪽을 들여다봐! 주변 아이템도 모아보고'));
      this.door = door;
      this.spawnItems(local);
    }
    this.doorYaw = yawRad || 0;
    this.door.object3D.position.copy(local);
    this.door.object3D.quaternion.setFromEuler(new THREE.Euler(0, this.doorYaw, 0));
  },

  rotateDoor(deg) {
    if (!this.door) { this.setHint('먼저 바닥을 탭해서 문을 놓아줘'); return; }
    this.doorYaw += deg * Math.PI / 180;
    this.door.object3D.quaternion.setFromEuler(new THREE.Euler(0, this.doorYaw, 0));
  },

  spawnItems(center) {
    const c = this.cfg.content;
    for (let i = 0; i < c.itemCount; i++) {
      const a = (i / c.itemCount) * Math.PI * 2 + Math.random() * 0.4;
      const r = c.itemRadius * (0.6 + Math.random() * 0.5);
      const item = document.createElement('a-entity');
      item.setAttribute('collectible', {type: i % 2 === 0 ? 'bell' : 'copter'});
      item.setAttribute('position', {
        x: center.x + Math.cos(a) * r,
        y: center.y + 0.7 + Math.random() * 0.7,
        z: center.z + Math.sin(a) * r,
      });
      this.root.appendChild(item);
    }
    this.total = c.itemCount;
  },

  // ── 앵커 저장 ─────────────────────────────────────────
  async saveAnchor() {
    if (!this.door) { this.setHint('먼저 바닥을 탭해서 문을 놓아줘'); return; }
    if (!this.localizedMapId) { this.setHint('측위가 성공해야 저장할 수 있어 (맵 좌표 기준이라서)'); return; }

    const p = this.door.object3D.position;
    const body = {position: {x: p.x, y: p.y, z: p.z}, rotationY: this.doorYaw * 180 / Math.PI};
    try {
      const j = await (await fetch(`/api/anchor/${this.localizedMapId}`, {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
      })).json();
      if (j.ok) {
        this.savedAnchor = j.anchor;
        this.updateAnchorLabel();
        this.setHint('저장 완료! 이제 누가 접속해도 이 자리에 나타나');
        Log.info('[anchor] 저장됨', JSON.stringify(body));
      } else {
        Log.error('[anchor] 저장 실패:', JSON.stringify(j));
      }
    } catch (e) {
      Log.error('[anchor] 저장 오류:', e.message);
    }
  },

  async deleteAnchor() {
    if (!this.localizedMapId) return;
    try {
      await fetch(`/api/anchor/${this.localizedMapId}`, {method: 'DELETE'});
      this.savedAnchor = false;
      this.updateAnchorLabel();
      this.setHint('저장된 위치를 삭제했어');
      Log.info('[anchor] 삭제됨');
    } catch (e) {
      Log.error('[anchor] 삭제 오류:', e.message);
    }
  },

  updateAnchorLabel() {
    const el = document.querySelector('#devAnchor');
    if (!el) return;
    if (this.savedAnchor) {
      const p = this.savedAnchor.position;
      el.textContent = `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)} / ${Math.round(this.savedAnchor.rotationY)}°`;
    } else {
      el.textContent = '없음';
    }
  },

  // ── 진단 표시 ─────────────────────────────────────────
  /**
   * 진단 표시.
   *
   * 핵심은 편차다. 여러 표본 쌍의 스케일이 일정하게 1 을 벗어나면 계통 오차(코드),
   * 제각각이면 측위가 불안정한 것(맵 품질)이다. 판정 문구가 이 둘을 갈라 준다.
   */
  showDiagnostics(d) {
    const $ = (id) => document.querySelector(id);
    const scale = $('#devScale');
    if (!scale) return;

    if (d && d.focal) {
      $('#devFocal').textContent = `${d.focal.f.toFixed(0)}px · ${d.focal.source}`;
    }

    if (!d || !d.ready) {
      scale.textContent = '–';
      $('#devPairs').textContent = `표본 ${d ? d.samples : 0}개`;
      $('#devAgree').textContent = '–';
      $('#devVerdict').className = 'verdict';
      $('#devVerdict').textContent =
        `측위 표본 ${d ? d.samples : 0}개. 1.2m 이상 떨어진 두 지점에서 측위돼야 검증값이 나옵니다. 방을 가로질러 걸어 보세요.`;
      return;
    }

    scale.textContent = `${d.scaleRatio.toFixed(3)}  (±${(d.spread * 100).toFixed(0)}%)`;
    $('#devPairs').textContent = `${d.pairs}쌍 / ${d.baseline.toFixed(1)}m · 측위오차 ≈±${d.estError.toFixed(2)}m`;
    $('#devAgree').textContent = `${d.agreePos.toFixed(2)}m / ${d.agreeDeg.toFixed(1)}°`;
    $('#devShift').textContent = `${(d.lastShift * 100).toFixed(0)}cm` + (d.rejected ? `  (무시 ${d.rejected})` : '');

    const verdict = $('#devVerdict');
    const off = Math.abs(d.scaleRatio - 1);

    if (d.ok) {
      verdict.className = 'verdict ok';
      verdict.textContent = '정상. 맵과 정렬이 모두 신뢰할 만합니다. 문 위치를 지정하세요.';
    } else if (!d.systematic) {
      verdict.className = 'verdict bad';
      verdict.textContent =
        `측위가 불안정합니다 — 측위마다 위치가 ±${d.estError.toFixed(2)}m 씩 다르게 나옵니다 ` +
        `(편차 ±${(d.spread * 100).toFixed(0)}%). 값이 계통적이지 않고 제각각이므로 ` +
        '코드가 아니라 맵 품질 문제일 가능성이 큽니다. 더 촘촘히, 여러 각도로 재스캔을 권합니다.';
    } else if (off >= 0.1) {
      verdict.className = 'verdict bad';
      verdict.textContent =
        `스케일이 ${d.scaleRatio.toFixed(2)}배로 일정하게 어긋납니다 (편차 ±${(d.spread * 100).toFixed(0)}%). ` +
        '계통 오차이므로 초점거리 자가 보정이 곧 적용됩니다. 계속 걸어 다니며 측위해 주세요.';
    } else {
      verdict.className = 'verdict bad';
      verdict.textContent =
        `스케일은 맞는데(${d.scaleRatio.toFixed(2)}) 두 지점 변환이 ${d.agreePos.toFixed(2)}m / ${d.agreeDeg.toFixed(0)}° 어긋납니다. ` +
        '좌표 규약 또는 맵 정확도 문제입니다.';
    }
  },

  /**
   * 씬 배율을 손으로 조정한다.
   * 기준자 상자가 실제 1m 로 보일 때까지 맞추면, 그 값이 곧 "맵 1m = 씬 몇 단위" 다.
   * 측위 없이도 조정할 수 있어 VPS 와 독립적으로 스케일을 잡을 수 있다.
   */
  nudgeSceneScale(factor) {
    const L = this.localizer;
    if (!L) { this.setHint('VPS 초기화 후에 조정할 수 있어'); return; }
    L.autoSceneScale = false;   // 손으로 만진 순간부터 자동 추정을 멈춘다
    L.sceneScale = factor == null ? 1 : L.sceneScale * factor;
    L.applied = false;          // 새 배율로 정렬을 다시 잡는다
    if (this.ruler) { this.toggleRuler(); this.toggleRuler(); }   // 기준자 다시 그리기
    this.setHint(`씬 배율 ${L.sceneScale.toFixed(3)} — 상자가 실제 1m 로 보일 때까지 맞춰줘`);
    Log.info(`[씬배율] 수동 조정 → ${L.sceneScale.toFixed(3)} (자동 추정 중단)`);
  },

  /**
   * 씬이 미터 단위인지 직접 확인하는 기준자.
   *
   * VPS·맵과 무관하게 8th Wall 씬 스케일만 잰다. 카메라 정면 2m 바닥에
   * 한 변 1m 짜리 상자를 놓는다. 콘텐츠 루트가 아니라 씬에 직접 붙이므로
   * 측위 결과에 전혀 영향받지 않는다.
   *
   * 실제로 1m 로 보이면 씬은 미터 단위다. 훨씬 크거나 작아 보이면
   * scale: absolute 가 먹지 않은 것이고, 그 배수가 곧 오차다.
   */
  toggleRuler() {
    const btn = document.querySelector('#devRuler');
    if (this.ruler) {
      this.ruler.parentNode.removeChild(this.ruler);
      this.ruler = null;
      btn.classList.remove('active');
      btn.textContent = '1m 기준자';
      return;
    }

    const cam = this.el.camera.el.object3D;
    const camWorld = new THREE.Vector3();
    cam.getWorldPosition(camWorld);
    const dir = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    dir.y = 0;
    dir.normalize();
    const at = camWorld.clone().addScaledVector(dir, 2);

    // 현재 씬 배율 기준으로 "실제 1m" 에 해당하는 크기로 그린다.
    // 배율이 맞으면 상자가 진짜 1m 로 보인다.
    const u = this.localizer ? this.localizer.sceneScale : 1;

    const g = document.createElement('a-entity');
    g.setAttribute('position', {x: at.x, y: 0, z: at.z});
    g.setAttribute('scale', `${u} ${u} ${u}`);

    const box = document.createElement('a-box');
    box.setAttribute('width', 1); box.setAttribute('height', 1); box.setAttribute('depth', 1);
    box.setAttribute('position', '0 0.5 0');
    box.setAttribute('material', 'color: #00e5ff; wireframe: true');
    g.appendChild(box);

    // 바닥에 10cm 눈금 자 (1m)
    for (let i = 0; i <= 10; i++) {
      const t = document.createElement('a-box');
      const big = i % 5 === 0;
      t.setAttribute('width', 0.012);
      t.setAttribute('height', 0.004);
      t.setAttribute('depth', big ? 0.16 : 0.08);
      t.setAttribute('position', `${-0.5 + i * 0.1} 0.002 0`);
      t.setAttribute('material', `shader: flat; color: ${big ? '#ffd900' : '#ffffff'}`);
      g.appendChild(t);
    }

    // 사람 키 기준 (1.7m) 막대
    const person = document.createElement('a-cylinder');
    person.setAttribute('radius', 0.02);
    person.setAttribute('height', 1.7);
    person.setAttribute('position', '0.8 0.85 0');
    person.setAttribute('material', 'shader: flat; color: #ff5aa5');
    g.appendChild(person);

    this.el.sceneEl.appendChild(g);   // ⚠ contentRoot 가 아니라 씬에 직접
    this.ruler = g;
    btn.classList.add('active');
    btn.textContent = '기준자 숨기기';
    this.setHint('파란 상자 한 변이 1m, 분홍 막대가 1.7m(사람 키). 실제와 비교해줘');
    Log.info(`[기준자] 씬 좌표 (${at.x.toFixed(2)}, 0, ${at.z.toFixed(2)}) 에 1m 상자 배치`);
  },

  /** 진단 상태를 한 덩어리 텍스트로 만들어 클립보드에 넣고 화면에도 띄운다. */
  copyReport() {
    const L = this.localizer;
    const d = L && L.diagnostics;
    const lines = [
      `map=${this.localizedMapId || '-'} 측위=${L ? `${L.successes}/${L.attempts}` : '-'}`,
      L && Object.keys(L.mapStats).length
        ? `맵별성공=${Object.entries(L.mapStats).map(([m, n]) => `${m}:${n}`).join(' ')}`
        : '',
      `f=${L && L.focalPx ? L.focalPx.toFixed(0) : '-'}px(${L ? L.focalSource : '-'}) 보정=${L ? L.calibrations : 0}회`,
      `규약=${L ? L.conventionName() : '-'} 씬배율=${L ? L.sceneScale.toFixed(3) : '-'}${L && !L.autoSceneScale ? '(수동)' : ''}`,
      d && d.ready
        ? `스케일=${d.scaleRatio.toFixed(3)} 편차=${(d.spread * 100).toFixed(0)}% 측위오차≈±${d.estError.toFixed(2)}m`
        : `스케일=미측정(표본 ${d ? d.samples : 0}, 1.2m 이상 이동 필요)`,
      d && d.ready
        ? `일치=${d.agreePos.toFixed(2)}m/${d.agreeDeg.toFixed(1)}° 쌍=${d.pairs} 기준선=${d.baseline.toFixed(1)}m`
        : '',
      `흔들림=${L ? (L.lastShift * 100).toFixed(0) : '-'}cm 무시=${L ? L.rejected : 0}회`,
      `특징점=${document.querySelector('#devPoints').textContent}`,
    ].filter(Boolean);
    const text = lines.join('\n');
    const out = document.querySelector('#devReportOut');
    out.textContent = text;
    out.classList.add('on');
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text)
        .then(() => this.setHint('진단 리포트를 클립보드에 복사했어'))
        .catch(() => this.setHint('복사 실패 — 아래 텍스트를 직접 선택해줘'));
    }
    Log.info('[리포트]\n' + text);
  },

  updateDevReadout() {
    if (!this.devMode) return;
    const cam = new THREE.Vector3();
    this.el.camera.el.object3D.getWorldPosition(cam);
    const f = (n) => n.toFixed(2);

    const camEl = document.querySelector('#devCam');
    if (camEl) {
      const moved = this._prevCam ? cam.distanceTo(this._prevCam) : 0;
      this._still = moved < 0.001 ? (this._still || 0) + 1 : 0;
      this._prevCam = cam.clone();
      // 카메라 y = 기기가 바닥에서 떨어진 높이. absolute 스케일이면 실제 미터여야 한다.
      const h = cam.y;
      const verdict = h > 0.8 && h < 2.2 ? '미터로 보임' : (this._still > 8 ? '정지!' : '⚠ 미터 아닐 수 있음');
      camEl.textContent = `${f(cam.x)}, ${f(cam.y)}, ${f(cam.z)} · 높이 ${verdict}`;
    }

    if (this.localizer) {
      const ss = document.querySelector('#devSceneScale');
      if (ss) {
        ss.textContent = `${this.localizer.sceneScale.toFixed(3)}`
          + (this.localizer.autoSceneScale ? '' : ' (수동)');
      }
      const s = document.querySelector('#devLocStat');
      if (s) s.textContent = `${this.localizer.successes} / ${this.localizer.attempts}`;
      const c = document.querySelector('#devConv');
      if (c) c.textContent = this.localizer.conventionName();
    }

    const cur = document.querySelector('#devCurrent');
    if (cur) {
      if (this.door) {
        const p = this.door.object3D.position;
        cur.textContent = `${f(p.x)}, ${f(p.y)}, ${f(p.z)} / ${Math.round(this.doorYaw * 180 / Math.PI)}°`;
      } else {
        cur.textContent = '없음';
      }
    }
  },

  onCollect(type) {
    this.count++;
    document.querySelector('#count').textContent = `${this.count} / ${this.total}`;
    const name = type === 'bell' ? '방울' : '대나무 헬리콥터';
    this.setHint(this.count >= this.total ? '전부 모았다! 🎉' : `${name} 획득!`);
  },

  // ── HUD ───────────────────────────────────────────────
  setHint(t) { const e = document.querySelector('#hint'); if (e) e.textContent = t; },
  setTracking(dot, text) {
    const d = document.querySelector('#dotTracking');
    const t = document.querySelector('#textTracking');
    if (d) d.className = `dot ${dot}`;
    if (t) t.textContent = text;
  },
  setVps(dot, text) {
    const d = document.querySelector('#dotVps');
    const t = document.querySelector('#textVps');
    if (d) d.className = `dot ${dot}`;
    if (t) t.textContent = text;
  },
});
