/** 시작 화면 제어 + 진입 로그. */
document.addEventListener('DOMContentLoaded', () => {
  const loader = document.getElementById('loader');
  const btn = document.getElementById('startBtn');

  const dismiss = () => {
    if (loader.classList.contains('hidden')) return;
    loader.classList.add('hidden');
    setTimeout(() => { loader.style.display = 'none'; }, 500);
  };

  btn.addEventListener('click', dismiss);
  loader.addEventListener('click', dismiss);

  // 카메라가 이미 붙었으면 시작 화면을 붙잡아 둘 이유가 없다.
  document.querySelector('a-scene').addEventListener('realityready', () => setTimeout(dismiss, 400));

  Log.info(`[app] 로드됨 — ${location.protocol}//${location.host}`);
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    Log.error('[app] HTTPS 가 아니면 카메라 권한을 받을 수 없어. https://<PC의 LAN IP>:3443 로 접속할 것.');
  }
});
