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
    maxAttempts: 20,        // 자동 측위 최대 시도 (성공 시 중단)
    maxDimension: 640,      // 서버로 보낼 캡처 이미지 최대 변 길이 (클수록 정확/느림)
  },

  // ── 콘텐츠 ────────────────────────────────────────────────
  content: {
    doorHeight: 2.0,        // 어디로든 문 높이(m)
    doorWidth: 0.95,        // 문 너비(m)
    itemCount: 5,           // 문 주변에 배치할 수집 아이템 개수
    itemRadius: 2.2,        // 배치 반경(m)
  },

  debug: true,              // 화면 하단 로그 패널 표시 (?debug=0 으로 끌 수 있음)
};
