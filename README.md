# 어디로든 문 AR — 8th Wall + Immersal (로컬 WebAR)

로컬 서버에서 바로 도는 WebAR 프로토타입.
8th Wall 엔진으로 SLAM(월드 트래킹), Immersal VPS 로 실제 공간 정렬을 담당한다.

```
바닥 탭 → 어디로든 문 배치 → 문 탭하면 열림(포털) → 주변 아이템 수집
                          ↑
            Immersal 측위 성공 시 콘텐츠 루트가 실제 공간 좌표로 정렬
```

---

## 1. 실행

```bash
npm install
npm start
```

```
HTTP   → http://localhost:3000        (PC 브라우저 확인용)
HTTPS  → https://localhost:3443
폰 접속 → https://<PC의 LAN IP>:3443   (인증서 경고는 "고급 → 계속 진행")
```

- 자체 서명 인증서는 최초 실행 시 `certs/` 에 자동 생성된다 (openssl 필요 — Git for Windows 에 포함).
- **폰 테스트는 반드시 HTTPS.** LAN IP 로 접속할 때 http 면 카메라 권한이 안 나온다.
- PC 브라우저에서는 SLAM 이 동작하지 않는다(후면 카메라 없음). UI·로직 확인용으로만 쓸 것.
- 화면 하단 로그 패널은 `?debug=1` 로 켜고 `?debug=0` 으로 끈다.

## 2. 8th Wall 관련 메모 (중요)

8th Wall 은 2026-02-28 로 호스팅 서비스가 종료되고 [8thwall.org](https://8thwall.org) 오픈소스로 전환됐다.

- **App Key 가 더 이상 필요 없다.** 예전 문서에 나오는 `appKey=...` 스크립트 태그는 무시할 것.
- 엔진은 CDN 으로 로드한다: `@8thwall/engine-binary` (SLAM 은 `data-preload-chunks="slam"`).
- 프레임워크는 8th Wall 이 패치한 A-Frame(**8-Frame 1.5.0**)을 쓴다 → `public/external/scripts/` 에 로컬 포함.
- 엔진/SLAM 은 바이너리 배포(MIT 아님), 나머지 모듈은 MIT.

### 완전 오프라인으로 돌리려면

CDN 3개를 로컬로 받아서 `index.html` 경로만 바꾸면 된다.

```bash
mkdir -p public/external/8thwall
curl -o public/external/8thwall/xr.js       https://cdn.jsdelivr.net/npm/@8thwall/engine-binary@1/dist/xr.js
curl -o public/external/8thwall/xr-slam.js  https://cdn.jsdelivr.net/npm/@8thwall/engine-binary@1/dist/xr-slam.js
curl -o public/external/8thwall/xrextras.js https://cdn.jsdelivr.net/npm/@8thwall/xrextras@1/dist/xrextras.js
```
(`xrextras` 는 `dist/resources/` 하위 파일도 함께 필요하다.)

## 3. Immersal VPS 설정

측위를 실제로 쓰려면 **미리 촬영·생성해 둔 맵**이 있어야 한다.

1. Immersal 앱으로 대상 공간 스캔 → Developer Portal 에서 맵 생성 → **map ID** 확보
2. Developer Portal 에서 **developer token** 확보
3. 프로젝트 루트에 `.env` 생성 (`.env.example` 복사)

```
IMMERSAL_TOKEN=여기에_토큰
IMMERSAL_MAP_IDS=12345,67890
```

4. 서버 재시작 → HUD 의 `VPS` 칩이 "VPS 대기" 로 바뀌면 준비 완료
5. 스캔했던 장소를 비추고 **VPS 측위** 버튼을 누르거나, 자동 측위(기본 3초 주기)를 기다린다

토큰은 서버 프록시(`/api/immersal/localize`)에서만 쓰이고 브라우저로 내려가지 않는다.

### 좌표계 캘리브레이션 (현장에서 확인할 것)

`public/js/immersal.js` 의 `CV_TO_GL` 이 Immersal(OpenCV 규약)→three.js 변환을 담당한다.
현장 첫 테스트에서 **콘텐츠가 상하/전후로 뒤집혀 보이면 이 행렬부터** 조정한다.
카메라 intrinsics 는 8th Wall 의 투영행렬에서 역산하는데, 값이 안 잡히면 화각 60° 가정으로
폴백하고 로그에 `intrinsics 추정값 사용 중` 을 남긴다 — 그 경우 정확도가 떨어진다.

## 4. Render 배포

로컬 HTTPS(자체서명)는 폰에서 매번 경고를 넘겨야 하고 사람마다 인증서를 신뢰시켜야 한다.
Render 에 올리면 진짜 HTTPS 도메인이 나와서 링크만 열면 카메라가 바로 뜬다.

`render.yaml` 블루프린트가 이미 들어있다.

```yaml
runtime: node / plan: free / region: singapore
buildCommand: npm ci
startCommand: node server.js
healthCheckPath: /healthz
```

### 절차

1. 이 디렉터리를 GitHub 저장소로 올린다 (`.env`, `certs/`, `node_modules/` 는 .gitignore 처리됨)
2. Render 대시보드 → **New → Blueprint** → 해당 저장소 선택 → `render.yaml` 자동 인식
3. 배포 후 **Environment** 탭에서 값 입력
   - `IMMERSAL_TOKEN`
   - `IMMERSAL_MAP_IDS`
   (`sync: false` 라서 blueprint 에는 값이 저장되지 않는다)
4. 발급된 `https://<서비스명>.onrender.com` 을 폰에서 열면 끝

### 프로덕션 동작 차이

| | 로컬 | Render |
|---|---|---|
| TLS | 자체서명 인증서 직접 생성 (`certs/`) | Render 가 앞단에서 처리, 앱은 HTTP 만 |
| 포트 | 3000 / 3443 | `process.env.PORT` 에 바인딩 |
| 정적 캐시 | `no-store` | 1시간 / 벤더 스크립트 1주 |

`NODE_ENV=production` 또는 `RENDER` 환경변수가 있으면 자동으로 프로덕션 모드로 뜬다.
로컬에서 확인하려면:

```bash
NODE_ENV=production PORT=4500 node server.js
```

### 주의

- **Free 플랜은 15분 미사용 시 슬립**된다. 다시 깨어나는 데 30초~1분 걸리니, 현장 시연 전에 한 번 열어서 예열해 둘 것.
- Immersal 측위 이미지(640px 그레이스케일 PNG)가 요청당 수백 KB다. Free 플랜 대역폭(월 100GB)은 시연 규모에선 충분하지만, 자동 측위 주기(`config.js` 의 `intervalMs`)를 너무 짧게 두지 말 것.
- 8th Wall 엔진은 jsDelivr CDN 에서 받는다. 폐쇄망 시연이면 README 2번의 오프라인 절차를 먼저 적용할 것.

## 5. 구조

```
server.js                      HTTP/HTTPS 개발 서버 + Immersal REST 프록시
public/
  index.html                   씬 정의 (a-scene, HUD, 스크립트 로드 순서)
  css/style.css
  external/scripts/            8-Frame 1.5.0 (8th Wall 패치 A-Frame)
  js/
    config.js                  ⚙ 튜닝 값 (문 크기, 아이템 수, 측위 주기…)
    logger.js                  화면 하단 디버그 로그
    textures.js                포털 밤하늘 텍스처 (캔버스 생성)
    png.js                     8-bit 그레이스케일 PNG 인코더 (Immersal 입력 포맷)
    immersal.js                측위 클라이언트 + 좌표 정렬 수학
    app.js                     시작 화면
    components/
      anywhere-door.js         어디로든 문 (절차적 생성, 열림/포털)
      collectible.js           방울 / 대나무 헬리콥터
      experience.js            전체 흐름 · HUD · VPS 연동
  assets/models/               .glb 넣는 자리
```

## 6. 에셋 교체

현재 문·아이템은 전부 프리미티브로 절차적 생성한다.
`.glb` 로 바꾸려면 `assets/models/` 에 넣고 해당 컴포넌트의 `build()` 를
`this.el.setAttribute('gltf-model', 'url(assets/models/door.glb)')` 로 대체하면 된다.

> ⚠ 도라에몽은 후지코 프로/쇼가쿠칸의 저작물이다. 지금 코드에 들어있는 형상은
> 캐릭터를 재현하지 않은 일반 도형이다. 실제 캐릭터 모델·이미지를 넣는다면
> 사내 프로토타입 범위를 넘어 배포하기 전에 권리 확인이 필요하다.

## 7. 다음 작업 후보

- [ ] 포털을 스텐실 마스크 기반으로 교체 (지금은 얕은 디오라마 방식)
- [ ] Immersal 맵 확보 후 `CV_TO_GL` / intrinsics 실측 캘리브레이션
- [ ] 측위 성공 후 지속적인 드리프트 보정(주기적 재측위 + 스무딩)
- [ ] 사운드(문 열림, 방울) 추가 — iOS 는 최초 터치에서 오디오 언락 필요
