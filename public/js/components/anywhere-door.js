/**
 * 어디로든 문 — 프리미티브만으로 절차적 생성.
 * .glb 를 넣고 싶으면 build() 대신 gltf-model 을 붙이면 된다.
 *
 * 이벤트: door-opened / door-closed
 */
AFRAME.registerComponent('anywhere-door', {
  schema: {
    width: {default: 0.95},
    height: {default: 2.0},
    color: {default: '#ff6fb5'},
  },

  init() {
    this.open = false;
    this.build();
    this.el.addEventListener('click', () => this.toggle());
  },

  build() {
    const {width: w, height: h, color} = this.data;
    const d = 0.09;   // 문 두께
    const b = 0.07;   // 문틀 두께

    // ── 문틀 ────────────────────────────────────────────
    const frame = document.createElement('a-entity');
    const side = (x) => {
      const e = document.createElement('a-box');
      e.setAttribute('width', b);
      e.setAttribute('height', h + b * 2);
      e.setAttribute('depth', d + 0.02);
      e.setAttribute('position', `${x} ${h / 2} 0`);
      e.setAttribute('material', `color: ${color}; roughness: 0.55; metalness: 0.05`);
      e.setAttribute('shadow', 'cast: true; receive: false');
      return e;
    };
    frame.appendChild(side(-(w / 2 + b / 2)));
    frame.appendChild(side(w / 2 + b / 2));

    const top = document.createElement('a-box');
    top.setAttribute('width', w + b * 2);
    top.setAttribute('height', b);
    top.setAttribute('depth', d + 0.02);
    top.setAttribute('position', `0 ${h + b / 2} 0`);
    top.setAttribute('material', `color: ${color}; roughness: 0.55`);
    top.setAttribute('shadow', 'cast: true; receive: false');
    frame.appendChild(top);
    this.el.appendChild(frame);

    // ── 문 안쪽(포털) ────────────────────────────────────
    this.portal = document.createElement('a-entity');
    this.portal.setAttribute('position', `0 ${h / 2} -0.02`);
    this.portal.setAttribute('visible', 'false');

    const sky = document.createElement('a-plane');
    sky.setAttribute('width', w);
    sky.setAttribute('height', h);
    sky.setAttribute('material', {shader: 'flat', src: window.makePortalTexture()});
    this.portal.appendChild(sky);

    // 안쪽 세계의 얕은 디오라마 — 문틀 폭 안에 들어가는 실루엣 레이어
    const layers = [
      {z: -0.06, y: -0.42, w: w * 0.92, h: 0.55, color: '#1c4f8c', opacity: 0.9},
      {z: -0.12, y: -0.30, w: w * 0.80, h: 0.75, color: '#123a6b', opacity: 0.85},
      {z: -0.18, y: -0.16, w: w * 0.62, h: 0.95, color: '#0d2a50', opacity: 0.8},
    ];
    this.parallax = [];
    layers.forEach((l, i) => {
      const p = document.createElement('a-plane');
      p.setAttribute('width', l.w);
      p.setAttribute('height', l.h);
      p.setAttribute('position', `0 ${l.y} ${l.z}`);
      p.setAttribute('material', `shader: flat; color: ${l.color}; transparent: true; opacity: ${l.opacity}`);
      p.setAttribute('animation__float', {
        property: 'position',
        dir: 'alternate',
        loop: true,
        dur: 2600 + i * 700,
        to: `${(i % 2 ? -1 : 1) * 0.04} ${l.y + 0.02} ${l.z}`,
        easing: 'easeInOutSine',
      });
      this.portal.appendChild(p);
      this.parallax.push(p);
    });
    this.el.appendChild(this.portal);

    // ── 문짝 (왼쪽 경첩 기준으로 회전) ─────────────────────
    this.hinge = document.createElement('a-entity');
    this.hinge.setAttribute('position', `${-w / 2} 0 0`);

    const panel = document.createElement('a-box');
    panel.setAttribute('width', w);
    panel.setAttribute('height', h);
    panel.setAttribute('depth', d);
    panel.setAttribute('position', `${w / 2} ${h / 2} 0`);
    panel.setAttribute('material', `color: ${color}; roughness: 0.5; metalness: 0.05`);
    panel.setAttribute('shadow', 'cast: true; receive: false');
    panel.classList.add('cantap');
    this.hinge.appendChild(panel);

    const knob = document.createElement('a-sphere');
    knob.setAttribute('radius', 0.045);
    knob.setAttribute('position', `${w - 0.13} ${h * 0.47} ${d / 2 + 0.01}`);
    knob.setAttribute('material', 'color: #ffd900; metalness: 0.85; roughness: 0.25');
    this.hinge.appendChild(knob);

    this.el.appendChild(this.hinge);
    this.panel = panel;
  },

  toggle() {
    this.open ? this.close() : this.openDoor();
  },

  openDoor() {
    if (this.open) return;
    this.open = true;
    this.portal.setAttribute('visible', 'true');
    this.hinge.setAttribute('animation__swing', {
      property: 'rotation',
      to: '0 -105 0',
      dur: 900,
      easing: 'easeOutBack',
    });
    this.el.emit('door-opened', null, false);
  },

  close() {
    if (!this.open) return;
    this.open = false;
    this.hinge.setAttribute('animation__swing', {
      property: 'rotation',
      to: '0 0 0',
      dur: 600,
      easing: 'easeInOutQuad',
    });
    setTimeout(() => { if (!this.open) this.portal.setAttribute('visible', 'false'); }, 600);
    this.el.emit('door-closed', null, false);
  },
});
