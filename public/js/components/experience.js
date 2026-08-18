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

    document.querySelector('#btnReset').addEventListener('click', () => this.reset());
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

    this.root.addEventListener('immersal-localized', () => {
      this.setHint('실제 공간에 정렬 완료! 문이 저장된 위치로 이동했어');
    });
  },

  // ── 배치 ──────────────────────────────────────────────
  placeDoor(point) {
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
      this.spawnItems(point);
      this.setHint('문을 탭하면 열려');
    }

    // 문이 사용자를 바라보도록 Y축 회전
    const cam = this.el.camera.el.object3D.position;
    const yaw = Math.atan2(cam.x - point.x, cam.z - point.z) * (180 / Math.PI);
    this.door.setAttribute('position', point);
    this.door.setAttribute('rotation', `0 ${yaw} 0`);
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
