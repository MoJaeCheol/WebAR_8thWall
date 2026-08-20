# 자체 VPS (self-hosted Visual Positioning System)

Immersal 을 대체하는 자체 측위 파이프라인. LiDAR 캡처(`capture-ios/`) → 맵 빌드 →
측위 서버 → 웹 클라이언트(`public/js/immersal.js` 의 `selfvps` 백엔드) 순으로 흐른다.

```
[iPhone Pro]  capture-ios 앱 — RGB + LiDAR 깊이 + ARKit 포즈 + intrinsics
      ↓ zip (AirDrop 등)
[PC]  import_dataset → build_map (SIFT + 깊이 역투영, 폴백 삼각측량) → data/maps/*.npz + .ply
      ↓
[PC]  FastAPI 측위 서버 :8000 — 이미지 → FLANN 매칭 → solvePnPRansac → 포즈
      ↓ Node 프록시 (/api/vps/*)
[폰]  웹앱 — 개발자 패널 "측위 백엔드: 자체 VPS" 토글
```

## 설치 (Windows, repo 루트에서)

```bash
python -m venv .venv
.venv\Scripts\pip install -r vps\requirements.txt
```

## 테스트 (폰 불필요 — 기하·규약·파이프라인 합성 검증)

```bash
.venv\Scripts\python -m pytest vps\tests -q
```

## 사용 순서

```bash
# 1) iOS 캡처 zip 가져오기 (검증 포함)
.venv\Scripts\python -m vps.builder.import_dataset path\to\cap_20260820_143000.zip

# 2) 맵 빌드 → data/maps/<name>.npz + .ply + maps.json 등록
.venv\Scripts\python -m vps.builder.build_map data\datasets\cap_20260820_143000

# 3) 측위 서버 기동 (Node 서버와 별도 창)
.venv\Scripts\python -m uvicorn vps.server.main:app --host 127.0.0.1 --port 8000

# 4) Node 서버 기동 (기존 그대로)
npm start
```

폰에서 웹앱 접속 → 개발자 모드(⚙) → **측위 백엔드: 자체 VPS** 로 전환.
기존 진단(스케일 비율·편차·일치도)과 "맵 특징점 겹쳐 보기"(PLY)가 그대로 동작한다.

## 좌표 규약 (계약 — vps/common/geometry.py 가 단일 소유)

- 월드: three.js/ARKit 규약 (우수, Y-up, 카메라 −Z 시선)
- manifest pose: `T_world_cam` row-major 16개
- `/localize` 응답: GL camera-to-map, Immersal 필드명(r00..r22, px..pz)
  → 클라이언트는 **규약 0번(항등)** 으로 해석 (Immersal 은 2번)
- OpenCV 변환(diag(1,−1,−1) 카메라 축 플립)은 geometry.py 안에서만 일어난다
- 이 계약은 `vps/tests/test_synthetic.py` 의 JSON 왕복 테스트로 봉인되어 있다

## 파라미터 (조정할 일이 생기면)

| 위치 | 값 | 의미 |
|---|---|---|
| `builder/features.py` | `EXTRACT_MAX_DIM = 1280` | 빌드·질의 공통 SIFT 해상도 |
| `builder/triangulate.py` | `REPROJ_THRESH_PX = 3` | 맵 포인트 검증 재투영 한계 |
| `builder/triangulate.py` | `MIN_PARALLAX_DEG = 1.5` | 삼각측량 최소 시차각 |
| `server/localizer.py` | `MIN_INLIERS = 20`, `MIN_INLIER_RATIO = 0.12` | 측위 수락 게이트 |
| `server/localizer.py` | `PNP_REPROJ_PX = 5` | RANSAC 인라이어 한계 |

수락 게이트를 낮추면 성공률은 오르지만 오수락 1번이 정렬을 통째로 틀 수 있다.
클라이언트의 outlier 거부(1.5m)가 2차 방어선이다.
