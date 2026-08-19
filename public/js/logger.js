/** 화면 하단 디버그 로그 패널. 폰에서 콘솔을 못 볼 때 쓴다. */
(function () {
  const params = new URLSearchParams(location.search);
  const enabled = params.get('debug') !== '0' && (window.AR_CONFIG?.debug || params.get('debug') === '1');

  let el = null;
  function panel() {
    if (el) return el;
    el = document.getElementById('log');
    if (el && enabled) {
      el.classList.add('on');
      document.body.classList.add('debug-on');
      // 로그가 하단 버튼을 가리지 않도록 접을 수 있게 한다.
      const btn = document.createElement('button');
      btn.id = 'logToggle';
      // 기본은 접힘. 로그가 화면을 점령하지 않게 한다.
      el.classList.add('collapsed');
      btn.textContent = '▼ 로그 보기';
      btn.addEventListener('click', () => {
        const collapsed = el.classList.toggle('collapsed');
        btn.textContent = collapsed ? '▼ 로그 보기' : '▲ 로그 닫기';
        if (!collapsed) el.scrollTop = el.scrollHeight;
      });
      document.body.appendChild(btn);
    }
    return el;
  }

  function write(msg, cls) {
    const p = panel();
    if (!p || !enabled) return;
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = `${new Date().toLocaleTimeString('ko-KR', {hour12: false})} ${msg}`;
    p.appendChild(line);
    while (p.childElementCount > 120) p.removeChild(p.firstChild);
    p.scrollTop = p.scrollHeight;
  }

  window.Log = {
    info: (...a) => { console.log(...a); write(a.join(' ')); },
    warn: (...a) => { console.warn(...a); write(a.join(' '), 'w'); },
    error: (...a) => { console.error(...a); write(a.join(' '), 'e'); },
    enabled,
  };

  window.addEventListener('error', (e) => window.Log.error('JS 오류:', e.message));
  window.addEventListener('unhandledrejection', (e) => window.Log.error('Promise 오류:', e.reason?.message || e.reason));
})();
