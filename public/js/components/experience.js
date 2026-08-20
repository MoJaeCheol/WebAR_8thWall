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
    this.localizer.conventionIndex = this.localizer.autoConvention ? 0 : conv;
    this.localizer.gravityLock = cfg.gravityLock !== false;
    if (cfg.smoothing !== undefined) this.localizer.smoothing = cfg.smoothing;
    if (cfg.outlierMeters !== undefined) this.localizer.outlierMeters = cfg.outlierMeters;
    this.localizer.autoCalibrate = cfg.autoCalibrate !== false;
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
      $('#devFocal').textContent =
        `${d.focal.f.toFixed(0)}px (×${d.focal.calib.toFixed(3)}${d.calibrations ? `, ${d.calibrations}회 보정` : ''})`;
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
      camEl.textContent = `${f(cam.x)}, ${f(cam.y)}, ${f(cam.z)}` + (this._still > 8 ? '  정지!' : '');
    }

    if (this.localizer) {
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
