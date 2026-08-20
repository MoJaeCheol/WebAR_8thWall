"""좌표 규약의 단일 소유자.

이 파이프라인의 모든 좌표 변환은 이 모듈을 통해서만 한다.
Immersal 때 규약 오판으로 시간을 태운 전례가 있으므로, GL↔CV 변환을
여기 한 곳에 모으고 tests/test_synthetic.py 의 왕복 테스트로 봉인한다.

규약 계약:
  - 월드/GL 프레임: three.js·ARKit 과 동일 — 우수(右手), Y-up, 카메라는 −Z 를 본다.
  - manifest 의 pose: T_world_cam (camera-to-world), 4×4 를 row-major 로 편 16개 배열.
  - OpenCV 카메라 프레임: x-우 / y-하 / z-전방. GL 카메라와의 차이는
    카메라 축 플립 F = diag(1, −1, −1) 하나뿐이다 (F 는 자기 자신이 역행렬).
  - /localize 응답: GL 규약 camera-to-map 을 Immersal 필드명(r00..r22, px..pz,
    row-major)으로 내보낸다 → 웹 클라이언트는 규약 0번(항등)으로 그대로 해석.
"""
from __future__ import annotations

import numpy as np

# GL 카메라 → CV 카메라 축 플립. 대각이므로 F @ F = I.
F_FLIP = np.diag([1.0, -1.0, -1.0])


def pose_from_manifest(pose16) -> tuple[np.ndarray, np.ndarray]:
    """manifest 의 row-major 16개 배열 → (R_wc 3×3, c 3) camera-to-world.

    R_wc 의 열이 GL 카메라 축(x-우, y-상, −z-시선)의 월드 방향이고 c 는 카메라 중심.
    """
    T = np.asarray(pose16, dtype=np.float64).reshape(4, 4)
    if not np.all(np.isfinite(T)):
        raise ValueError("pose에 비유한 값이 있음")
    if not np.allclose(T[3], [0, 0, 0, 1], atol=1e-6):
        raise ValueError(f"pose 마지막 행이 [0,0,0,1] 이 아님: {T[3]}")
    R = T[:3, :3]
    if not np.allclose(R @ R.T, np.eye(3), atol=1e-4):
        raise ValueError("pose 회전이 직교가 아님")
    return R, T[:3, 3].copy()


def pose_to_manifest(R_wc: np.ndarray, c: np.ndarray) -> list[float]:
    """(R_wc, c) → manifest 용 row-major 16개 배열."""
    T = np.eye(4)
    T[:3, :3] = R_wc
    T[:3, 3] = c
    return [float(v) for v in T.reshape(-1)]


def world_to_cv_extrinsics(R_wc: np.ndarray, c: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """GL camera-to-world → OpenCV 외부 파라미터 (월드→CV카메라).

    p_cv = R_cv · X_world + t_cv,  이후 u = fx·x/z + cx 로 투영.
    """
    R_cw_gl = R_wc.T
    R_cv = F_FLIP @ R_cw_gl
    t_cv = -R_cv @ c
    return R_cv, t_cv


def cv_extrinsics_to_gl_pose(R_cv: np.ndarray, t_cv: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """OpenCV 외부 파라미터(solvePnP 출력) → GL camera-to-world. 위의 역."""
    c = -R_cv.T @ t_cv
    R_wc = (F_FLIP @ R_cv).T  # R_cv = F · R_wc^T 이므로
    return R_wc, c


def K_matrix(fx: float, fy: float, cx: float, cy: float) -> np.ndarray:
    return np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=np.float64)


def project(K: np.ndarray, R_cv: np.ndarray, t_cv: np.ndarray, X: np.ndarray):
    """월드 점 (N×3) → 픽셀 (N×2), CV z-깊이 (N,). z ≤ 0 은 카메라 뒤."""
    X = np.atleast_2d(X)
    p = X @ R_cv.T + t_cv
    z = p[:, 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        uv = (p[:, :2] / z[:, None]) * [K[0, 0], K[1, 1]] + [K[0, 2], K[1, 2]]
    return uv, z


def backproject(K: np.ndarray, uv: np.ndarray, z: np.ndarray,
                R_wc: np.ndarray, c: np.ndarray) -> np.ndarray:
    """픽셀 (N×2) + CV z-깊이(미터, LiDAR depthMap 값) → 월드 점 (N×3).

    LiDAR depthMap 은 광선 거리가 아니라 카메라 평면 수직 z-깊이다.
    """
    uv = np.atleast_2d(uv)
    z = np.atleast_1d(z)
    x = (uv[:, 0] - K[0, 2]) / K[0, 0] * z
    y = (uv[:, 1] - K[1, 2]) / K[1, 1] * z
    p_cv = np.stack([x, y, z], axis=1)
    p_gl = p_cv @ F_FLIP.T  # F 는 대각이라 사실상 부호 플립
    return p_gl @ R_wc.T + c


def gl_pose_to_response(R_wc: np.ndarray, c: np.ndarray) -> dict:
    """GL camera-to-map → /localize 응답 필드 (Immersal 필드명, row-major)."""
    out = {"px": float(c[0]), "py": float(c[1]), "pz": float(c[2])}
    for i in range(3):
        for j in range(3):
            out[f"r{i}{j}"] = float(R_wc[i, j])
    return out


def response_to_gl_pose(resp: dict) -> tuple[np.ndarray, np.ndarray]:
    """응답 → (R_wc, c). 웹 클라이언트 규약 0번(전치 없음)과 동일한 해석.

    테스트에서 클라이언트 수식(T_track_map = T_track_cam · inv(T_map_cam))을
    재현할 때 쓴다.
    """
    R = np.array([[resp[f"r{i}{j}"] for j in range(3)] for i in range(3)])
    c = np.array([resp["px"], resp["py"], resp["pz"]])
    return R, c
