/**
 * 프로젝트 설정.
 * ⚠ 이 파일은 브라우저로 그대로 내려간다. 비밀 토큰(Immersal token 등)은 넣지 말 것.
 *   → Immersal 토큰/맵ID 는 프로젝트 루트 .env 에 넣고 서버 프록시(/api/immersal/*)가 처리한다.
 *
 * 참고: 8th Wall 은 2026-02 오픈소스 전환 이후 App Key 가 필요 없다.
 *       엔진은 index.html 에서 CDN(@8thwall/engine-binary)으로 직접 로드한다.
 */
window.AR_CONFIG = {
  // ── Immersal VPS ─────────────────────────────────────────
  immersal: {
    enabled: true,          // 서버(.env)에 토큰/맵이 설정돼 있을 때만 실제로 동작
    autoLocalize: true,     // 진입 후 자동 반복 측위
    intervalMs: 3000,       // 측위 요청 주기(ms)
    maxAttempts: 40,        // 자동 측위 최대 시도
    continuous: true,       // 성공해도 계속 측위 — 두 지점 측위가 있어야 정렬 진단이 된다
    maxDimension: 640,      // 서버로 보낼 캡처 이미지 최대 변 길이 (클수록 정확/느림)

    // 포즈 규약. 'auto' 면 중력 정렬을 기준으로 자동 선택한다.
    // Immersal 맵도 8th Wall SLAM 도 중력 정렬(Y 위)이므로, 올바른 변환은
    // yaw 만 있고 기울기가 0 이어야 한다. 후보 중 기울기가 가장 작은 것이 정답.
    // 숫자(0~7)를 넣으면 그 규약으로 고정된다. HUD 의 "정렬 보정" 버튼도 수동 고정.
    poseConvention: 'auto',

    // 남은 pitch/roll 을 버리고 yaw 만 사용. 두 좌표계 모두 중력 정렬이라
    // 기울기는 측위 오차일 뿐이고, 버리는 편이 안정적이다.
    gravityLock: true,

    // 측위 성공 시 콘텐츠를 세울 "맵 좌표계" 위치.
    // 맵 원점(0,0,0)은 스캔을 시작한 지점이다. 원하는 자리에 두려면
    // 한 번 탭으로 배치한 뒤 로그의 "배치 좌표(맵 기준)" 값을 여기에 옮겨 적으면 된다.
    anchor: {
      enabled: true,
      position: {x: 0, y: 0, z: 0},
      rotationY: 0,         // 도(°)
    },
  },

  // ── 콘텐츠 ────────────────────────────────────────────────
  content: {
    doorHeight: 2.0,        // 어디로든 문 높이(m)
    doorWidth: 0.95,        // 문 너비(m)
    itemCount: 5,           // 문 주변에 배치할 수집 아이템 개수
    itemRadius: 2.2,        // 배치 반경(m)
  },

  // 개발자 모드는 우상단 ⚙ 버튼으로 켠다 (localStorage 에 저장되어 새로고침해도 유지)
};
