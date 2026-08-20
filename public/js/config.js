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

    // 정렬 적용 정책. 측위는 계속 돌지만 성공할 때마다 정렬을 통째로 덮어쓰면
    // 콘텐츠가 주기마다 튄다. 첫 정렬만 즉시 적용하고 이후엔 조금씩 당긴다.
    smoothing: 0.25,        // 0 = 이후 갱신 안 함, 1 = 매번 덮어쓰기
    outlierMeters: 1.5,     // 이보다 멀리 튀는 측위 결과는 오측위로 보고 무시

    // 초점거리 자가 보정. reality.intrinsics 는 화면에 맞춰 잘린 렌더 투영이라
    // 그대로 쓰면 과대평가된다. 측정된 스케일 비율이 곧 오차 배수이므로
    // 흩어짐이 작을 때(계통 오차일 때)만 그 값으로 보정한다.
    autoCalibrate: true,
    maxDimension: 640,      // 서버로 보낼 캡처 이미지 최대 변 길이 (클수록 정확/느림)

    // 포즈 규약. Immersal 공식 WebAR 구현(immersal/vps-for-web)이 응답 회전에
    // X축 180°(= diag(1,-1,-1))를 후곱하므로 2번이 정답이다. 추측할 필요가 없다.
    // 'auto' 로 두면 예전처럼 지표 기반으로 고르지만, 근거가 확실하므로 고정한다.
    poseConvention: 2,

    // 초점거리 초기 가정 화각(도). 폰 후면 카메라 통상값.
    // 이후 스케일 비율로 자가 보정되고, 수렴값은 기기별로 저장된다.
    initialFovDeg: 64,

    // 기기 자세 prior 전송. 공식 구현은 gyro 기반 쿼터니언을 함께 보내지만,
    // 우리 카메라 회전은 트래킹 프레임 기준이라 정렬 완료 후에만 의미가 있다.
    // 효과가 확인되지 않았으므로 기본 꺼둠.
    sendOrientationPrior: false,

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
