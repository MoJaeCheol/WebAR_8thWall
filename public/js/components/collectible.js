/**
 * 수집 아이템 — 'bell'(방울) 또는 'copter'(대나무 헬리콥터).
 * 탭하면 사라지면서 씬에 'item-collected' 이벤트를 올린다.
 */
AFRAME.registerComponent('collectible', {
  schema: {
    type: {default: 'bell', oneOf: ['bell', 'copter']},
    bob: {default: 0.08},
  },

  init() {
    this.collected = false;
    this.data.type === 'copter' ? this.buildCopter() : this.buildBell();

    // 위아래로 둥실 + 천천히 회전
    const y = this.el.object3D.position.y;
    this.el.setAttribute('animation__bob', {
      property: 'object3D.position.y',
      from: y - this.data.bob,
      to: y + this.data.bob,
      dir: 'alternate',
      loop: true,
      dur: 1600 + Math.random() * 600,
      easing: 'easeInOutSine',
    });
    this.el.setAttribute('animation__spin', {
      property: 'object3D.rotation.y',
      from: 0,
      to: Math.PI * 2,
      loop: true,
      dur: 5000,
      easing: 'linear',
    });

    this.hit = document.createElement('a-sphere');   // 탭 판정용 투명 구
    this.hit.setAttribute('radius', 0.16);
    this.hit.setAttribute('material', 'opacity: 0; transparent: true; shader: flat');
    this.hit.classList.add('cantap');
    this.el.appendChild(this.hit);
    this.hit.addEventListener('click', () => this.collect());
  },

  buildBell() {
    const body = document.createElement('a-sphere');
    body.setAttribute('radius', 0.09);
    body.setAttribute('material', 'color: #ffd900; metalness: 0.75; roughness: 0.28');
    this.el.appendChild(body);

    const ring = document.createElement('a-torus');
    ring.setAttribute('radius', 0.032);
    ring.setAttribute('radius-tubular', 0.008);
    ring.setAttribute('position', '0 0.105 0');
    ring.setAttribute('material', 'color: #d9a600; metalness: 0.8; roughness: 0.3');
    this.el.appendChild(ring);

    const slit = document.createElement('a-box');   // 방울 앞면 가로 홈
    slit.setAttribute('width', 0.12);
    slit.setAttribute('height', 0.014);
    slit.setAttribute('depth', 0.02);
    slit.setAttribute('position', '0 -0.01 0.082');
    slit.setAttribute('material', 'color: #5a4300; shader: flat');
    this.el.appendChild(slit);

    const dot = document.createElement('a-sphere');
    dot.setAttribute('radius', 0.018);
    dot.setAttribute('position', '0 -0.045 0.078');
    dot.setAttribute('material', 'color: #5a4300; shader: flat');
    this.el.appendChild(dot);
  },

  buildCopter() {
    const cap = document.createElement('a-cylinder');
    cap.setAttribute('radius', 0.055);
    cap.setAttribute('height', 0.035);
    cap.setAttribute('material', 'color: #ffd900; metalness: 0.2; roughness: 0.6');
    this.el.appendChild(cap);

    const shaft = document.createElement('a-cylinder');
    shaft.setAttribute('radius', 0.012);
    shaft.setAttribute('height', 0.07);
    shaft.setAttribute('position', '0 0.052 0');
    shaft.setAttribute('material', 'color: #e0a800');
    this.el.appendChild(shaft);

    const rotor = document.createElement('a-entity');
    rotor.setAttribute('position', '0 0.09 0');
    [0, 90].forEach((deg) => {
      const blade = document.createElement('a-box');
      blade.setAttribute('width', 0.24);
      blade.setAttribute('height', 0.006);
      blade.setAttribute('depth', 0.045);
      blade.setAttribute('rotation', `0 ${deg} 0`);
      blade.setAttribute('material', 'color: #ffe95c; metalness: 0.1; roughness: 0.7');
      rotor.appendChild(blade);
    });
    rotor.setAttribute('animation__rotor', {
      property: 'object3D.rotation.y',
      from: 0, to: Math.PI * 2, loop: true, dur: 420, easing: 'linear',
    });
    this.el.appendChild(rotor);
  },

  collect() {
    if (this.collected) return;
    this.collected = true;
    this.hit.classList.remove('cantap');

    this.el.removeAttribute('animation__bob');
    this.el.setAttribute('animation__pickup', {
      property: 'object3D.position.y',
      to: this.el.object3D.position.y + 0.55,
      dur: 550,
      easing: 'easeOutCubic',
    });
    this.el.setAttribute('animation__shrink', {
      property: 'scale',
      to: '0.001 0.001 0.001',
      dur: 550,
      easing: 'easeInCubic',
    });

    this.el.sceneEl.emit('item-collected', {type: this.data.type}, false);
    setTimeout(() => this.el.parentNode && this.el.parentNode.removeChild(this.el), 600);
  },
});
