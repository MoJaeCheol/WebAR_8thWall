"""fx 정밀화 — 입력 B(웹 캡처, intrinsics 가 화각 가정) 전용.

캡처 카메라는 한 대이므로 전 프레임 공통 배수 m 하나를 fx·fy 에 곱한다.
각 후보 m 으로 트랙 서브셋을 재삼각측량해 중앙 재투영 오차가 최소인 m 을 고른다.
오차 곡선을 함께 돌려주므로 최소점이 얕으면(신뢰도 낮음) 로그에서 드러난다.

입력 A(ARKit)는 공장 캘리브레이션 intrinsics 라 이 단계를 건너뛴다.
"""
from __future__ import annotations

import numpy as np

from ..common import geometry
from .triangulate import FrameFeatures, MIN_PARALLAX_DEG, _ray_world, _triangulate_pair


def _scaled_K(K: np.ndarray, m: float) -> np.ndarray:
    Km = K.copy()
    Km[0, 0] *= m
    Km[1, 1] *= m
    return Km


def refine_fx(ff: list[FrameFeatures], tracks: list[list[tuple[int, int]]],
              span: float = 0.25, steps: int = 21, max_tracks: int = 2000):
    """반환: (best_multiplier, [(m, median_err_px), ...])."""
    rng = np.random.default_rng(0)
    usable = []
    for tr in tracks:
        best, best_ang = None, 0.0
        for a in range(len(tr)):
            for b in range(a + 1, len(tr)):
                fa, ka = tr[a]
                fb, kb = tr[b]
                ang = np.degrees(np.arccos(np.clip(
                    _ray_world(ff[fa], ka) @ _ray_world(ff[fb], kb), -1, 1)))
                if ang > best_ang:
                    best_ang, best = ang, (fa, ka, fb, kb)
        if best is not None and best_ang >= MIN_PARALLAX_DEG:
            usable.append((tr, best))
    if len(usable) > max_tracks:
        usable = [usable[i] for i in rng.choice(len(usable), max_tracks, replace=False)]
    if not usable:
        return 1.0, []

    curve = []
    for m in np.linspace(1 - span, 1 + span, steps):
        errs = []
        for tr, (fa, ka, fb, kb) in usable:
            A, B = ff[fa], ff[fb]
            KA, KB = _scaled_K(A.K, m), _scaled_K(B.K, m)
            import cv2
            PA = KA @ np.hstack([A.R_cv, A.t_cv[:, None]])
            PB = KB @ np.hstack([B.R_cv, B.t_cv[:, None]])
            Xh = cv2.triangulatePoints(PA, PB,
                                       A.kp[ka].reshape(2, 1).astype(np.float64),
                                       B.kp[kb].reshape(2, 1).astype(np.float64))
            X = (Xh[:3] / Xh[3]).ravel()
            for fi, ki in tr:
                f = ff[fi]
                uv, z = geometry.project(_scaled_K(f.K, m), f.R_cv, f.t_cv, X[None, :])
                if z[0] > 0:
                    errs.append(np.linalg.norm(uv[0] - f.kp[ki]))
        curve.append((float(m), float(np.median(errs)) if errs else np.inf))

    best_m = min(curve, key=lambda x: x[1])[0]
    return best_m, curve
