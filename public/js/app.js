/** 시작 화면 제어 + 진입 로그. */
document.addEventListener('DOMContentLoaded', () => {
  const loader = document.getElementById('loader');
  const btn = document.getElementById('startBtn');

  const dismiss = () => {
    if (loader.classList.contains('hidden')) return;
    loader.classList.add('hidden');
    setTimeout(() => { loader.style.display = 'none'; }, 500);
  };

  // iOS 는 IMU(가속도·자이로) 접근에 명시적 권한이 필요하고, 사용자 제스처 안에서만
  // 요청할 수 있다. IMU 없이는 SLAM 스케일이 영영 안 잡힌다 — 시작 탭에서 요청한다.
  const askMotion = () => {
    try {
      if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') {
        DeviceMotionEvent.requestPermission()
          .then((s) => Log.info('[권한] 모션 센서:', s))
          .catch((e) => Log.warn('[권한] 모션 센서 요청 실패:', e.message));
      }
      if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().catch(() => {});
      }
    } catch (e) {}
  };

  btn.addEventListener('click', () => { askMotion(); dismiss(); });
  loader.addEventListener('click', () => { askMotion(); dismiss(); });

  // 카메라가 이미 붙었으면 시작 화면을 붙잡아 둘 이유가 없다.
  document.querySelector('a-scene').addEventListener('realityready', () => setTimeout(dismiss, 400));

  Log.info(`[app] 로드됨 — ${location.protocol}//${location.host}`);

  // 지금 폰이 어떤 버전을 돌리고 있는지 확인용.
  // 화면의 build 값과 서버 값이 다르면 캐시된 옛 파일을 보고 있는 것이다.
  const tag = document.querySelector('link[href*="style.css"]');
  const clientV = tag ? (new URL(tag.href, location.href).searchParams.get('v') || '없음') : '없음';
  fetch('/api/config').then((r) => r.json()).then((j) => {
    const same = clientV === j.buildId;
    Log.info(`[app] build ${clientV} / 서버 ${j.buildId} ${same ? '(최신)' : '(⚠ 캐시된 옛 파일 — 새로고침 필요)'}`);
    const el = document.querySelector('#devBuild');
    if (el) el.textContent = same ? `build ${j.buildId}` : `⚠ 캐시 ${clientV}≠${j.buildId}`;
  }).catch(() => {});
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    Log.error('[app] HTTPS 가 아니면 카메라 권한을 받을 수 없어. https://<PC의 LAN IP>:3443 로 접속할 것.');
  }
});
