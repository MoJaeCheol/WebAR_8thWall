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

### 개발자 모드 (우상단 ⚙)

URL 쿼리가 아니라 화면 우상단 톱니 버튼으로 진입한다. `localStorage` 에 저장되어
새로고침해도 유지되고, 다시 누르면 관람 모드로 돌아간다.

**관람 모드에서는 아무것도 배치하지 않는다.** 개발자가 저장해 둔 위치가 있을 때만
그 자리에 세운다. 바닥을 탭해도 반응하지 않는다 — "누가 와도 같은 자리" 가 요점이므로
관람자가 위치를 바꿀 수 있으면 안 되고, 저장된 위치가 없다고 아무 데나 놓아서도 안 된다.

패널은 세 부분이다.

**1. 맵 검증**

| 항목 | 보는 법 |
|---|---|
| 특징점 수 | 맵의 밀도. 방 하나에 수천 개면 무난, 수백 개면 재스캔 권장 |
| 측위 성공 | 성공/시도. 절반 이하면 맵 품질이나 촬영 각도 문제 |
| 스케일 | `1.00` 이어야 한다 (Immersal 이동거리 ÷ SLAM 이동거리) |
| 두 지점 일치 | `0m / 0°` 에 가까워야 한다 |

**맵 특징점 겹쳐 보기** 버튼이 결정적이다. Immersal 에서 포인트 클라우드(`/sparse`)를
받아 AR 로 겹쳐 그린다. **점들이 실제 방의 벽·가구와 맞아 떨어지면 맵과 정렬이 모두
정상**이고, 어긋나 있으면 그 어긋난 방향과 양이 곧 문제의 크기다.
숫자를 해석할 필요 없이 눈으로 판정된다.

**2. 문 위치 지정**

1. 바닥을 탭해 문을 원하는 자리로
2. `↺ 15°` / `15° ↻` 로 각도 조정
3. `저장` → 서버에 기록. 이후 모든 접속자가 그 자리에서 본다
4. `저장 삭제` 로 취소

**3. 진단** — 카메라 좌표(정지 여부), 현재 포즈 규약, 규약 수동 변경, 로그 보기.

**API**

```
GET    /api/anchor/:mapId        저장된 위치 조회
POST   /api/anchor/:mapId        {position:{x,y,z}, rotationY} 저장
DELETE /api/anchor/:mapId        저장 삭제
GET    /api/anchors              전체 덤프 (커밋용)
GET    /api/map/:mapId/pointcloud  맵 특징점 (Immersal /sparse 중계, 메모리 캐시)
```

> ⚠ **Render 무료 플랜은 파일시스템이 휘발성이다.** 저장한 좌표는 재배포 시 사라진다.
> 확정된 좌표는 `GET /api/anchors` 로 덤프해 `data/anchors.json` 에 커밋해야 영구 보존된다.
> 저장할 때 서버 로그에도 커밋용 JSON 이 찍힌다.

### 스케일은 반드시 absolute (놓치기 쉬움)

`xrweb` 의 기본 스케일은 `responsive` 로, **미터가 아니라** "1프레임 카메라를 원점으로 한
정규화 좌표" 를 돌려준다. Immersal 맵은 실제 미터 기준이라 이 상태로 합성하면
스케일이 어긋나 정렬이 틀어진다. 증상이 헷갈리는데, **탭 배치는 멀쩡한데 VPS 정렬만
어긋나고 거리가 멀수록 오차가 커지면** 이걸 의심할 것.

```html
<a-scene xrweb="allowedDevices: any; scale: absolute">
```

`experience.js` 에서 `XR8.XrController.configure({scale: 'absolute'})` 로 한 번 더 확정한다.

### 맵 원점 마커

`debug: true` 면 측위 성공 시 맵 좌표계 원점(0,0,0)에 축 기즈모가 뜬다 (X 빨강 / Y 초록 / Z 파랑).

**맵 원점은 스캔을 시작한 지점이 아니다.** 재구성 솔버가 정한 임의의 지점이라
벽 속이나 공중일 수도 있다. 콘텐츠가 엉뚱한 데 있을 때, 정렬이 틀린 건지
원점이 원래 거기인 건지를 이 마커로 가른다.

- 마커가 **실제 공간에 딱 붙어서 안 흔들리면** → 정렬은 정상. `anchor.position` 만 옮기면 된다
- 마커가 **걸을 때마다 미끄러지거나 엉뚱한 데 있으면** → 정렬 문제

### 정렬 적용 정책 — 콘텐츠가 튀지 않게

측위는 진단을 위해 계속 돌지만(`continuous: true`), **성공할 때마다 정렬을 통째로
덮어쓰면 콘텐츠가 주기마다 튄다.** 특징점을 겹쳐 보면 이게 그대로 드러난다.

그래서 샘플 수집과 정렬 적용을 분리했다.

| | 동작 |
|---|---|
| 첫 측위 | 즉시 적용 |
| 이후 측위 | `smoothing`(기본 0.25) 만큼만 당긴다 — 드리프트는 보정되고 튀지는 않는다 |
| `outlierMeters`(기본 1.5m) 초과 | 오측위로 보고 **무시**. 콘텐츠가 날아가지 않는다 |

**정렬 흔들림** 값이 이 상태를 보여준다. 몇 cm면 정상 지터,
30cm 이상이면 측위가 불안정하다는 뜻이고 판정 문구에도 잡힌다.

검증: 최초 측위는 정답 위치에 정확히 적용, 이후 ±3cm 노이즈 측위 3회에서
루트는 6~11mm 만 이동, 3m 이상치는 실제 이동 0cm 로 무시.

### 정렬 자기 진단 — "맞는지 알 수가 없다" 를 없애는 장치

정답 데이터 없이도 정렬이 맞는지 판정할 수 있다. **서로 떨어진 두 지점에서 측위**하면 된다.

| 지표 | 정상값 | 틀리면 |
|---|---|---|
| **스케일** = Immersal 이동거리 ÷ SLAM 이동거리 | `1.00` | 씬이 미터 단위가 아님 (`scale: absolute` 확인) |
| **일치오차** = 두 측위가 각각 계산한 변환의 차이 | `0m / 0°` | 좌표 규약이 틀렸거나 트래킹 드리프트 |

`?debug=1` 이면 화면에 진단 칩이 뜬다. 초록이면 정상, 빨강이면 불량이다.

```
스케일 1.00  |  일치 0.04m/0.8°  |  정상
```

**사용법**: 측위가 한 번 성공한 뒤 **1m 이상 걸어가서** 다시 측위되면 값이 채워진다.
`continuous: true` 라 성공 후에도 계속 측위하므로 걷기만 하면 자동으로 채워진다.

이 지표는 규약 선택에도 쓴다. 두 지점 측위가 있으면 **두 변환이 가장 잘 일치하는 규약**을
고르고(강한 근거), 아직 없으면 중력 어긋남이 가장 작은 규약을 고른다(약한 근거).

합성 데이터 검증: 규약 0~3 각각을 정답으로 인코딩한 두 지점 샘플에 대해 4/4 정확히
판별했고(일치오차 0.000m/0.0°), 씬 스케일을 1.5배 어긋뜨린 경우 스케일 0.667 로
검출해 "불량" 판정했다.

### 좌표계 기준점 주의

SLAM 카메라 포즈는 XR8 의 `reality.position` 이 아니라 **씬 그래프상의 카메라 월드 행렬**을
쓴다. `xrweb` 은 카메라를 재부모화(`disableCameraReparenting: false`)하므로 두 값이
어긋날 수 있고, 콘텐츠 루트(`#contentRoot`)는 씬 그래프에 있으니 씬 기준이 맞다.

### 수동 정렬 보정

Immersal 응답은 문서상 **오른손 좌표계 · ARKit 중력 정렬(Y 위)** 의 camera-to-map 포즈다.
three.js 와 같은 규약이므로 변환 없이 그대로 쓰는 `poseConvention: 0` 이 기본값이다.
다만 문서의 "rotation is submitted as a row matrix" 표현 때문에 행/열 해석에 여지가 있어,
후보 8종을 넣어두고 화면에서 돌려볼 수 있게 했다.

**절차**

1. 스캔한 장소에서 측위를 성공시킨다
2. 문이 엉뚱한 데 있으면 HUD 의 **정렬 보정** 버튼을 누른다 (재측위 없이 즉시 재정렬)
3. 실제 공간과 맞는 번호를 찾으면 `config.js` 의 `poseConvention` 에 그 번호를 적어 고정한다

**후보 좁히기** — 로그의 `자체검증 오차` 를 보면 된다.
문서상 `px,py,pz` 는 "맵 공간에서의 카메라 위치"이므로, 카메라를 맵 좌표계로 되돌렸을 때
그 값과 일치해야 한다. 이 검증을 통과하는 건 **0~3번뿐**이고 4~7번은 구조적으로 어긋난다.
즉 실질 후보는 4개다.

| 번호 | 내용 | 비고 |
|---|---|---|
| 0 | 변환 없음 | 문서상 가장 유력 (기본값) |
| 1 | 회전행렬 전치 | row/column 해석 차이 |
| 2 | Y·Z 반전 | OpenCV 규약 가정 (구버전 구현) |
| 3 | Y·Z 반전 + 전치 | |
| 4~7 | 켤레 변환 / 뷰행렬 해석 | 자체검증 실패 — 사실상 제외 |

수학 자체는 왕복 테스트로 검증했다. 정답 변환을 정해 응답을 역산한 뒤 다시 적용하면
규약 0 에서 위치 오차 0m, 회전 오차 0° 로 복원된다. 따라서 현장에서 어긋난다면
계산이 아니라 **규약 선택**의 문제다.

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

### 현장 진단 계측 (`?debug=1`)

화면 하단 초록 칩에 실시간 상태가 뜬다.

```
cam 1.24,1.55,-0.80  |  문까지 2.31m  |  18mm
```

| 읽는 법 | 의미 |
|---|---|
| 걸을 때 **`문까지` 값이 변한다** | 문이 공간에 고정됨 — 정상 |
| 걸어도 **`문까지` 값이 그대로다** | 문이 카메라를 따라다님 — 월드 트래킹 미동작 |
| **`카메라 정지 ⚠`** | 카메라 좌표가 2초 넘게 안 변함. 실기기는 손떨림만으로도 움직이므로 SLAM 이 죽은 것 |

계측은 렌더 루프(`tick`)가 아니라 독립 타이머로 돈다.
렌더 루프에 걸면 루프가 멈췄을 때 계측도 같이 멈춰서 정작 이상 신호를 놓친다.

**로그 패널은 화면 위쪽에 배치한다.** 버튼은 아래, 로그는 위 — 구조적으로 겹칠 수 없다.
z-index 와 padding 으로 조정하던 방식은 뷰포트 높이가 바뀌면 다시 겹쳤다.
기본은 접힘이고 상단 `▼ 로그 보기` 로 펼친다.

375×812 / 320×568 / 360×440 뷰포트에서 로그 접힘·펼침 양쪽 모두
버튼 7개 전부 `elementFromPoint` 로 클릭 가능함을 확인했다.

### 캐시 — 고친 코드가 폰에 안 내려갈 때

`Cache-Control` 만으로는 **이미 캐시된 응답을 되돌릴 수 없다.** 헤더를 고쳐도
브라우저는 만료 전까지 서버에 묻지 않는다. 그래서 URL 자체를 바꾼다.

- 서버가 `index.html` 을 직접 만들어 내보내며 `css/js` 경로에 `?v=<BUILD_ID>` 를 붙인다
  (`BUILD_ID` 는 서버 기동 시각 기반이라 배포마다 바뀐다)
- `index.html` 자체는 `no-store`
- 장기 캐시는 파일명에 버전이 박힌 `external/` 벤더 스크립트에만

`?debug=1` 이면 화면에 `build <id>` 칩이 뜬다. **서버 값과 다르면 캐시된 옛 파일을
보고 있다는 뜻**이고 칩이 `⚠ 캐시 …≠…` 로 바뀐다.

이미 옛 `index.html` 이 캐시된 상태라면 주소에 아무 쿼리나 하나 더 붙여 열면 된다
(예: `?debug=1&x=1`). 다른 URL 이라 새로 받아온다.

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
