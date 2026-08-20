# ARCapture — LiDAR 맵 캡처 앱 (iOS)

iPhone Pro(LiDAR)로 공간을 캡처해 자체 VPS 맵 빌더(`vps/`)의 입력 데이터셋을 만든다.
키프레임마다 **같은 프레임의** RGB + LiDAR 깊이 + confidence + ARKit 포즈 + intrinsics 를
저장하고, PC 파이프라인이 그대로 읽는 `manifest.json` 을 직접 출력한다 — 변환 단계가 없다.

## 요구 사항

- Mac + Xcode 15 이상
- iPhone Pro / Pro Max (12 Pro 이후) 또는 LiDAR iPad Pro, iOS 16+
- Apple ID (무료 개발자 서명이면 충분 — 7일마다 재설치 필요)

## Xcode 프로젝트 만들기 (5분)

이 저장소는 Windows 에서 관리되므로 Xcode 프로젝트 파일(.xcodeproj)은 커밋하지 않는다.
Mac 에서 아래 절차로 만든다.

1. Xcode → **File > New > Project… > iOS > App**
   - Product Name: `ARCapture` / Interface: **SwiftUI** / Language: **Swift**
   - 저장 위치는 아무 데나 (저장소 밖 권장)
2. 템플릿이 만든 `ContentView.swift`, `ARCaptureApp.swift`(또는 `<이름>App.swift`)를 **삭제**하고,
   이 폴더의 `ARCapture/*.swift` 3개 파일을 프로젝트에 **드래그해 추가** (Copy items if needed 체크)
3. 프로젝트 설정 → 타깃 **ARCapture → Info** 탭에서 키 추가:
   | 키 | 값 |
   |---|---|
   | `Privacy - Camera Usage Description` | `공간 캡처를 위해 카메라를 사용합니다` |
   | `Application supports iTunes file sharing` (`UIFileSharingEnabled`) | `YES` |
   | `Supports opening documents in place` (`LSSupportsOpeningDocumentsInPlace`) | `YES` |
4. **Signing & Capabilities** → Team 에 본인 Apple ID 선택 (Personal Team)
5. iPhone 연결 → 상단 기기 선택 → **Run(⌘R)**
   - 처음엔 iPhone 의 설정 > 일반 > VPN 및 기기 관리에서 개발자 앱 신뢰 필요

## 캡처 방법

1. 앱 실행 → 트래킹이 **"트래킹 정상"(초록)** 이 될 때까지 주변을 천천히 비춘다
2. **캡처 시작** → 걸으면서 공간을 훑는다
   - 키프레임은 이동 15cm 또는 회전 12° 마다 자동 채택된다
   - **한 바퀴 루프 + 대각 횡단 2회**, 방 하나 기준 **80~150장** 권장
   - 벽에서 1~2m 거리 유지 (LiDAR 유효 거리 ~5m)
   - 트래킹이 노랑으로 떨어지면 채택이 멈춘다 — 천천히 움직여 복구할 것
3. **캡처 종료** → `manifest.json` 이 확정된다

## PC 로 옮기기

1. iPhone **파일 앱 → 나의 iPhone → ARCapture** → `cap_YYYYMMDD_HHMMSS` 폴더를 **길게 눌러 "압축"**
2. zip 을 AirDrop / 메신저 / USB(Finder 파일 공유) 로 PC 에 전송
3. PC 의 저장소에서:

```bash
python -m vps.builder.import_dataset path/to/cap_20260820_143000.zip
```

검증 후 `data/datasets/` 에 풀리고 빌드 명령을 안내한다. 이어서:

```bash
python -m vps.builder.build_map data/datasets/cap_20260820_143000
```

## 산출물 형식

```
cap_YYYYMMDD_HHMMSS/
  manifest.json        # vps/common/dataset.py 가 읽는 형식 (version 1)
  frames/000000.jpg    # RGB, 센서 landscape 방향 (보통 1920×1440)
  depth/000000.f32     # 256×192 float32 LE, 카메라 z-깊이(미터)
  depth/000000.conf    # 256×192 uint8 (0/1/2 = low/med/high) — med 미만은 빌더가 무시
```

좌표 규약: ARKit `camera.transform` 을 row-major 로 편 T_world_cam.
ARKit 카메라 프레임은 GL(우수, Y-up, −Z 시선)이라 three.js 와 동일 — 변환 없음.
`worldAlignment = .gravity` 라 Y 축이 중력 반대 방향으로 보장된다.
