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

### 콘텐츠를 맵의 어느 자리에 세울지 (anchor)

VPS 를 쓰는 목적은 "정해진 자리에 항상 같은 게 보이는 것" 이다.
`config.js` 의 `immersal.anchor` 가 그 자리를 정한다 — **맵 좌표계** 기준이고,
원점 `(0,0,0)` 은 스캔을 시작한 지점이다.

```js
anchor: { enabled: true, position: {x: 0, y: 0, z: 0}, rotationY: 0 }
```

원하는 자리를 찾는 방법:

1. 현장에서 측위를 성공시킨다
2. 바닥을 탭해서 문을 원하는 위치로 옮긴다
3. 로그의 `배치 좌표(맵 기준): {x: …, y: …, z: …}` 값을 `anchor.position` 에 옮겨 적는다

이후로는 측위만 성공하면 그 자리에 자동으로 나타난다.

> ⚠ 콘텐츠는 전부 `#contentRoot` 아래에 있고, 측위가 성공하면 이 루트에 변환이 걸린다.
> 그래서 월드 좌표를 자식 엔티티의 position 에 그대로 넣으면 안 된다.
> `placeDoor()` 가 `worldToLocal()` 로 변환해주니, 새 콘텐츠를 추가할 때도 같은 방식을 쓸 것.

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

### 좌표계 정렬 보정 (현장에서 30초)

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
