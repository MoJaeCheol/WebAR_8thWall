/** 화면 로그 패널. 캡처는 항상 하고, 표시 여부는 개발자 패널이 제어한다. */
(function () {
  let el = null;
  function panel() {
    if (!el) el = document.getElementById('log');
    return el;
  }

  function write(msg, cls) {
    const p = panel();
    if (!p) return;
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = `${new Date().toLocaleTimeString('ko-KR', {hour12: false})} ${msg}`;
    p.appendChild(line);
    while (p.childElementCount > 200) p.removeChild(p.firstChild);
    p.scrollTop = p.scrollHeight;
  }

  window.Log = {
    info: (...a) => { console.log(...a); write(a.join(' ')); },
    warn: (...a) => { console.warn(...a); write(a.join(' '), 'w'); },
    error: (...a) => { console.error(...a); write(a.join(' '), 'e'); },
  };

  window.addEventListener('error', (e) => window.Log.error('JS 오류:', e.message));
  window.addEventListener('unhandledrejection', (e) => window.Log.error('Promise 오류:', e.reason?.message || e.reason));
})();
