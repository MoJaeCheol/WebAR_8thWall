/**
 * 체험 전체 흐름 관리 — 배치 / 수집 / HUD / VPS 연동.
 * a-scene 에 붙인다.
 */
AFRAME.registerComponent('dora-experience', {
  init() {
    const CFG = window.AR_CONFIG;
    this.cfg = CFG;
    this.count = 0;
    this.door = null;

    this.hud = {
      tracking: document.querySelector('#dotTracking'),
      trackingText: document.querySelector('#textTracking'),
      vps: document.querySelector('#dotVps'),
      vpsText: document.querySelector('#textVps'),
      hint: document.querySelector('#hint'),
      count: document.querySelector('#count'),
    };

    this.root = document.querySelector('#contentRoot');
    this.ground = document.querySelector('#ground');

    // 저작 모드에서만 탭으로 옮길 수 있다. 관람 모드는 저장된 자리에 고정.
    this.editMode = new URLSearchParams(location.search).get('edit') === '1';
    this.ground.addEventListener('click', (e) => {
      if (!this.editMode) return;
      this.placeDoor(e.detail.intersection.point);
    });
    if (this.editMode) {
      document.body.classList.add('edit-mode');
      Log.info('[app] 저작 모드 — 배치 후 저장하면 모든 접속자에게 적용된다');
    }
    this.el.addEventListener('item-collected', (e) => this.onCollect(e.detail.type));

    // 측위 성공 시 맵 좌표에 콘텐츠를 세운다 (VPS 를 쓰는 본래 목적).
    // initImmersal() 안이 아니라 여기에 두어야 카메라 초기화 순서와 무관하게 항상 등록된다.
    this.root.addEventListener('immersal-localized', (e) => {
      const resp = e.detail && e.detail.response;
      this.localizedMapId = resp && resp.map;
      this.onLocalized(resp);
    });

    document.querySelector('#btnReset').addEventListener('click', () => this.reset());
    document.querySelector('#btnSummon').addEventListener('click', () => this.summonInFront());
    document.querySelector('#btnConvention').addEventListener('click', () => this.cycleConvention());
    document.querySelector('#btnRotL').addEventListener('click', () => this.rotateDoor(-15));
    document.querySelector('#btnRotR').addEventListener('click', () => this.rotateDoor(15));
    document.querySelector('#btnSave').addEventListener('click', () => this.saveAnchor());
    document.querySelector('#btnLocalize').addEventListener('click', () => {
      this.setHint('VPS 측위 시도 중… 스캔했던 장소를 비춰줘');
      this.localizer && this.localizer.localizeOnce();
    });

    // ── 8th Wall 트래킹 상태 ────────────────────────────
    this.el.addEventListener('realityready', () => {
      this.setTracking('ok', '트래킹 준비됨');
      this.setHint(this.editMode
        ? '저작 모드 — 측위되면 바닥을 탭해 문을 놓고 저장해줘'
        : '주변을 천천히 비춰줘. 위치가 인식되면 문이 나타나');
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

  // ── Immersal ──────────────────────────────────────────
  async initImmersal() {
    const cfg = this.cfg.immersal;
    if (!cfg.enabled) { this.setVps('', 'VPS 꺼짐'); return; }
    if (typeof XR8 === 'undefined' || !XR8.CameraPixelArray) {
      this.setVps('err', 'VPS 사용 불가');
      Log.warn('[immersal] XR8.CameraPixelArray 없음');
      return;
    }

    this.localizer = new window.ImmersalLocalizer({
      rootEl: this.root,
      onStatus: (s) => {
        const map = {
          idle:     ['warn', 'VPS 대기'],
          pending:  ['pending', 'VPS 측위 중'],
          ok:       ['ok', 'VPS 정렬됨'],
          fail:     ['warn', 'VPS 재시도'],
          disabled: ['', 'VPS 미설정'],
        };
        const [dot, text] = map[s] || ['', 'VPS'];
        this.setVps(dot, text);
      },
    });

    // 스케일을 미터로 확정한다.
    // xrweb 의 기본값 responsive 는 "1프레임 카메라 기준 정규화 좌표"라 미터가 아니고,
    // 실제 미터로 만들어진 Immersal 맵과 합성하면 스케일이 어긋난다.
    try {
      XR8.XrController.configure({scale: 'absolute'});
      Log.info('[8thwall] scale = absolute (미터 단위)');
    } catch (e) {
      Log.warn('[8thwall] scale 설정 실패:', e.message);
    }

    const conv = cfg.poseConvention;
    this.localizer.autoConvention = (conv === 'auto' || conv === undefined);
    this.localizer.conventionIndex = this.localizer.autoConvention ? 0 : conv;
    this.localizer.gravityLock = cfg.gravityLock !== false;
    document.querySelector('#convIdx').textContent = this.localizer.autoConvention ? '자동' : conv;
    this.localizer.attachPipeline(cfg.maxDimension);
    const ready = await this.localizer.checkServer();
    if (ready && cfg.autoLocalize) {
      this.localizer.startAuto({intervalMs: cfg.intervalMs, maxAttempts: cfg.maxAttempts});
    }
  },

  // ── 배치 ──────────────────────────────────────────────
  /**
   * 맵 좌표계 원점(0,0,0)에 축 기즈모를 세운다.
   * 맵 원점은 스캔 시작점이 아니라 재구성 솔버가 정한 임의의 지점이라,
   * "콘텐츠가 이상한 곳에 있다" 가 정렬 오류인지 원점 위치 탓인지 눈으로 가른다.
   */
  showOriginMarker() {
    if (this.originMarker) return;
    const g = document.createElement('a-entity');
    const axis = (color, rot) => {
      const c = document.createElement('a-cylinder');
      c.setAttribute('radius', 0.012);
      c.setAttribute('height', 0.5);
      c.setAttribute('position', '0 0.25 0');
      c.setAttribute('material', `shader: flat; color: ${color}`);
      const pivot = document.createElement('a-entity');
      pivot.setAttribute('rotation', rot);
      pivot.appendChild(c);
      return pivot;
    };
    g.appendChild(axis('#ff4444', '0 0 -90'));  // X
    g.appendChild(axis('#44ff44', '0 0 0'));    // Y
    g.appendChild(axis('#4488ff', '90 0 0'));   // Z
    const dot = document.createElement('a-sphere');
    dot.setAttribute('radius', 0.05);
    dot.setAttribute('material', 'shader: flat; color: #ffffff');
    g.appendChild(dot);
    this.root.appendChild(g);
    this.originMarker = g;
    Log.info('[app] 맵 원점 마커 표시 (X 빨강 / Y 초록 / Z 파랑)');
  },

  /**
   * 측위 성공 시 호출. 서버에 저장된 배치 좌표를 가져와 그 자리에 세운다.
   * 이게 VPS 의 본체다 — 누가 언제 와도 같은 자리, 같은 각도.
   */
  async onLocalized(response) {
    if (this.cfg.debug) this.showOriginMarker();

    const mapId = response && response.map;
    let anchor = null;

    if (mapId && mapId > 0) {
      try {
        const r = await fetch(`/api/anchor/${mapId}`);
        const j = await r.json();
        if (j.found) {
          anchor = j.anchor;
          Log.info(`[anchor] 서버 배치 좌표 사용 (map ${mapId}, 저장 ${anchor.updated || '-'})`);
        }
      } catch (e) {
        Log.warn('[anchor] 조회 실패:', e.message);
      }
    }

    // 서버에 없으면 config 의 기본값으로 (최초 저작 전 상태)
    if (!anchor) {
      const c = this.cfg.immersal.anchor;
      if (!c || !c.enabled) { this.setHint('정렬 완료 — 배치 좌표가 아직 없어'); return; }
      anchor = {position: c.position, rotationY: c.rotationY || 0};
      Log.info('[anchor] 저장된 좌표 없음 → config 기본값 사용');
    }

    const p = anchor.position;
    this.placeDoorLocal(
      new THREE.Vector3(p.x, p.y, p.z),
      (anchor.rotationY || 0) * Math.PI / 180
    );
    this.setHint(this.editMode
      ? '저작 모드 — 바닥을 탭해 옮기고, 각도 맞춘 뒤 저장'
      : '문을 탭하면 열려');
  },

  /**
   * 월드(트래킹) 공간 좌표를 받아 콘텐츠 루트의 로컬 좌표로 변환해 배치한다.
   * 측위가 성공하면 #contentRoot 에 변환이 걸리므로, 월드 좌표를 그대로 넣으면 안 된다.
   */
  placeDoor(worldPoint) {
    const root3D = this.root.object3D;
    root3D.updateMatrixWorld(true);

    const local = root3D.worldToLocal(
      new THREE.Vector3(worldPoint.x, worldPoint.y, worldPoint.z)
    );

    // 문이 사용자를 바라보도록 — 월드 기준 각을 구한 뒤 루트 회전을 상쇄한다.
    const camWorld = new THREE.Vector3();
    this.el.camera.el.object3D.getWorldPosition(camWorld);
    const worldYaw = Math.atan2(camWorld.x - worldPoint.x, camWorld.z - worldPoint.z);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, worldYaw, 0));
    const rootQ = new THREE.Quaternion();
    root3D.getWorldQuaternion(rootQ);
    q.premultiply(rootQ.invert());
    const localYaw = new THREE.Euler().setFromQuaternion(q, 'YXZ').y;

    this.placeDoorLocal(local, localYaw);
  },

  /** 콘텐츠 루트의 로컬 좌표(= 맵 좌표)와 yaw(라디안)로 직접 배치한다. */
  placeDoorLocal(local, yawRad) {
    const c = this.cfg.content;

    if (!this.door) {
      const door = document.createElement('a-entity');
      door.setAttribute('anywhere-door', {width: c.doorWidth, height: c.doorHeight});
      door.setAttribute('scale', '0.001 0.001 0.001');
      this.root.appendChild(door);
      door.setAttribute('animation__pop', {
        property: 'scale', to: '1 1 1', dur: 700, easing: 'easeOutElastic',
      });
      door.addEventListener('door-opened', () => this.setHint('문 안쪽을 들여다봐! 주변 아이템도 모아보고'));
      this.door = door;
      this.spawnItems(local);
    }

    this.doorYaw = yawRad || 0;
    this.door.object3D.position.copy(local);
    this.door.object3D.quaternion.setFromEuler(new THREE.Euler(0, this.doorYaw, 0));
    this.updateEditReadout();
  },

  /** 저작 모드 — 문을 회전시킨다. */
  rotateDoor(deltaDeg) {
    if (!this.door) { this.setHint('먼저 바닥을 탭해서 문을 놓아줘'); return; }
    this.doorYaw += deltaDeg * Math.PI / 180;
    this.door.object3D.quaternion.setFromEuler(new THREE.Euler(0, this.doorYaw, 0));
    this.updateEditReadout();
  },

  /** 저작 모드 — 현재 배치를 서버에 저장한다. 이후 접속자 모두에게 적용된다. */
  async saveAnchor() {
    if (!this.door) { this.setHint('먼저 문을 배치해줘'); return; }
    const mapId = this.localizedMapId;
    if (!mapId) { this.setHint('측위가 성공해야 저장할 수 있어 (맵 좌표 기준이라서)'); return; }

    const p = this.door.object3D.position;
    const body = {
      position: {x: p.x, y: p.y, z: p.z},
      rotationY: this.doorYaw * 180 / Math.PI,
    };
    try {
      const r = await fetch(`/api/anchor/${mapId}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (j.ok) {
        this.setHint('저장 완료! 이제 누가 접속해도 이 자리에 나타나');
        Log.info(`[anchor] 저장됨 map=${mapId} ${JSON.stringify(body)}`);
      } else {
        this.setHint('저장 실패 — 로그 확인');
        Log.error('[anchor] 저장 실패:', JSON.stringify(j));
      }
    } catch (e) {
      Log.error('[anchor] 저장 오류:', e.message);
    }
  },

  updateEditReadout() {
    const el = document.querySelector('#editReadout');
    if (!el || !this.door) return;
    const p = this.door.object3D.position;
    const f = (n) => n.toFixed(2);
    el.textContent = `x ${f(p.x)}  y ${f(p.y)}  z ${f(p.z)}  /  ${(this.doorYaw * 180 / Math.PI).toFixed(0)}°`;
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

  onCollect(type) {
    this.count++;
    this.hud.count.textContent = `${this.count} / ${this.total}`;
    const name = type === 'bell' ? '방울' : '대나무 헬리콥터';
    this.setHint(this.count >= this.total ? '전부 모았다! 🎉' : `${name} 획득!`);
  },

  reset() {
    while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
    this.door = null;
    this.originMarker = null;
    this.count = 0;
    this.total = 0;
    this.hud.count.textContent = '0 / 0';
    this.setHint(this.editMode ? '저작 모드 — 바닥을 탭해 문을 놓아줘' : '주변을 비춰줘');
    Log.info('[app] 리셋됨');
  },

  /** 포즈 규약을 하나씩 돌려보며 실제 공간과 맞는 번호를 찾는다. 재측위 불필요. */
  cycleConvention() {
    if (!this.localizer) { this.setHint('VPS 가 아직 준비되지 않았어'); return; }
    const name = this.localizer.setConvention(this.localizer.conventionIndex + 1);
    document.querySelector('#convIdx').textContent = this.localizer.conventionIndex;
    this.setHint(`정렬 규약 ${name} — 문 위치가 맞아?`);
  },

  // ── HUD ───────────────────────────────────────────────
  setHint(t) { if (this.hud.hint) this.hud.hint.textContent = t; },
  setTracking(dot, text) {
    if (this.hud.tracking) this.hud.tracking.className = `dot ${dot}`;
    if (this.hud.trackingText) this.hud.trackingText.textContent = text;
  },
  setVps(dot, text) {
    if (this.hud.vps) this.hud.vps.className = `dot ${dot}`;
    if (this.hud.vpsText) this.hud.vpsText.textContent = text;
  },
});
