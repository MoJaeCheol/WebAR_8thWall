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

    this.ground.addEventListener('click', (e) => this.placeDoor(e.detail.intersection.point));
    this.el.addEventListener('item-collected', (e) => this.onCollect(e.detail.type));

    // 측위 성공 시 맵 좌표에 콘텐츠를 세운다 (VPS 를 쓰는 본래 목적).
    // initImmersal() 안이 아니라 여기에 두어야 카메라 초기화 순서와 무관하게 항상 등록된다.
    this.root.addEventListener('immersal-localized', () => this.onLocalized());

    document.querySelector('#btnReset').addEventListener('click', () => this.reset());
    document.querySelector('#btnSummon').addEventListener('click', () => this.summonInFront());
    document.querySelector('#btnLocalize').addEventListener('click', () => {
      this.setHint('VPS 측위 시도 중… 스캔했던 장소를 비춰줘');
      this.localizer && this.localizer.localizeOnce();
    });

    // ── 8th Wall 트래킹 상태 ────────────────────────────
    this.el.addEventListener('realityready', () => {
      this.setTracking('ok', '트래킹 준비됨');
      this.setHint('바닥을 탭해서 어디로든 문을 놓아봐');
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

    this.localizer.attachPipeline(cfg.maxDimension);
    const ready = await this.localizer.checkServer();
    if (ready && cfg.autoLocalize) {
      this.localizer.startAuto({intervalMs: cfg.intervalMs, maxAttempts: cfg.maxAttempts});
    }
  },

  // ── 배치 ──────────────────────────────────────────────
  onLocalized() {
    const anchor = this.cfg.immersal.anchor;
    if (anchor && anchor.enabled && !this.door) {
      const q = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(0, (anchor.rotationY || 0) * Math.PI / 180, 0)
      );
      const p = anchor.position || {x: 0, y: 0, z: 0};
      this.placeDoorLocal(new THREE.Vector3(p.x, p.y, p.z), q);
      this.setHint('실제 공간에 정렬 완료! 문이 저장된 위치에 나타났어');
    } else {
      this.setHint('실제 공간에 정렬 완료!');
    }
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

    // 문이 사용자를 바라보도록 — 월드 기준으로 각을 구한 뒤 루트 회전을 상쇄한다.
    const camWorld = new THREE.Vector3();
    this.el.camera.el.object3D.getWorldPosition(camWorld);
    const worldYaw = Math.atan2(camWorld.x - worldPoint.x, camWorld.z - worldPoint.z);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, worldYaw, 0));
    const rootQ = new THREE.Quaternion();
    root3D.getWorldQuaternion(rootQ);
    q.premultiply(rootQ.invert());

    this.placeDoorLocal(local, q);
  },

  /** 콘텐츠 루트의 로컬 좌표(= 측위 성공 시 맵 좌표)에 직접 배치한다. */
  placeDoorLocal(local, quat) {
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
      this.setHint('문을 탭하면 열려');
    }

    this.door.object3D.position.copy(local);
    if (quat) this.door.object3D.quaternion.copy(quat);

    // 이 좌표를 config.js 의 anchor 에 박아두면 다음부터 자동으로 같은 자리에 나온다.
    const f = (n) => Number(n.toFixed(3));
    Log.info(`[app] 배치 좌표(맵 기준): {x: ${f(local.x)}, y: ${f(local.y)}, z: ${f(local.z)}}`);
  },

  /** 디버그용 — 트래킹/측위 상태와 무관하게 카메라 정면 2m 바닥에 소환한다. */
  summonInFront() {
    const cam = this.el.camera.el.object3D;
    const camWorld = new THREE.Vector3();
    cam.getWorldPosition(camWorld);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    dir.y = 0;
    dir.normalize();
    const target = camWorld.clone().addScaledVector(dir, 2);
    target.y = 0;   // 바닥 높이
    Log.info(`[app] 정면 소환 → world(${target.x.toFixed(2)}, ${target.y.toFixed(2)}, ${target.z.toFixed(2)})`);
    this.placeDoor(target);
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
    this.count = 0;
    this.total = 0;
    this.hud.count.textContent = '0 / 0';
    this.setHint('바닥을 탭해서 어디로든 문을 놓아봐');
    Log.info('[app] 리셋됨');
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
