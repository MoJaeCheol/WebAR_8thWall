/** 외부 이미지 파일 없이 캔버스로 만드는 텍스처들. */
(function () {
  let portalCache = null;

  /** 문 안쪽에 보일 밤하늘 그라디언트 + 별 */
  function makePortalTexture() {
    if (portalCache) return portalCache;
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 512;
    const g = c.getContext('2d');

    const grad = g.createLinearGradient(0, 0, 0, c.height);
    grad.addColorStop(0.00, '#04122b');
    grad.addColorStop(0.45, '#0d3f7a');
    grad.addColorStop(0.72, '#2a8fd4');
    grad.addColorStop(1.00, '#ffd08a');
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);

    // 별
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * c.width;
      const y = Math.random() * c.height * 0.6;
      const r = Math.random() * 1.4 + 0.3;
      g.globalAlpha = 0.25 + Math.random() * 0.7;
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }

    // 지평선 근처 빛번짐
    g.globalAlpha = 0.35;
    const glow = g.createRadialGradient(c.width / 2, c.height * 0.86, 4, c.width / 2, c.height * 0.86, c.width * 0.7);
    glow.addColorStop(0, '#fff3c4');
    glow.addColorStop(1, 'rgba(255,243,196,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, c.width, c.height);
    g.globalAlpha = 1;

    portalCache = c.toDataURL('image/png');
    return portalCache;
  }

  window.makePortalTexture = makePortalTexture;
})();
