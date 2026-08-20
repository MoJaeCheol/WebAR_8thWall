"""합성 씬 생성기 — SIFT 를 우회하고 기하·매칭 배관만 결정론적으로 검증한다.

포인트마다 고유 랜덤 128차원 단위 서술자를 부여하고, 관측마다 미세 노이즈를
더한다. ratio test·FLANN·union-find 가 실제 코드 경로 그대로 돌지만
결과는 재현 가능하다.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ..common import geometry
from ..common.dataset import Frame, Intrinsics

DESC_DIM = 128


def look_at_pose(c: np.ndarray, target: np.ndarray) -> np.ndarray:
    """카메라 중심 c 에서 target 을 보는 GL camera-to-world 회전."""
    fwd = target - c
    fwd = fwd / np.linalg.norm(fwd)
    z = -fwd                       # GL 카메라는 -Z 를 본다
    x = np.cross([0.0, 1.0, 0.0], z)
    x = x / np.linalg.norm(x)
    y = np.cross(z, x)
    return np.stack([x, y, z], axis=1)


@dataclass
class Scene:
    points: np.ndarray        # P×3 월드
    point_desc: np.ndarray    # P×128 (단위 벡터)
    frames: list[Frame]       # 포즈·intrinsics 만 채운 Frame (이미지/깊이 없음)
    intr: Intrinsics


def make_scene(n_points=500, n_cams=20, seed=0,
               fx=1100.0, width=1280, height=720) -> Scene:
    rng = np.random.default_rng(seed)
    pts = np.stack([rng.uniform(-3, 3, n_points),
                    rng.uniform(0, 3, n_points),
                    rng.uniform(-3, 3, n_points)], axis=1)
    desc = rng.standard_normal((n_points, DESC_DIM)).astype(np.float32)
    desc /= np.linalg.norm(desc, axis=1, keepdims=True)

    intr = Intrinsics(fx, fx, width / 2, height / 2, width, height)
    target = np.array([0.0, 1.5, 0.0])
    frames = []
    for i in range(n_cams):
        ang = 2 * np.pi * i / n_cams
        c = np.array([np.cos(ang) * 4.5, 1.6 + 0.2 * np.sin(3 * ang), np.sin(ang) * 4.5])
        frames.append(Frame(
            index=i, image_path=None, depth_path=None, conf_path=None, depth_size=None,
            R_wc=look_at_pose(c, target), c=c, intr=intr, t=float(i)))
    return Scene(points=pts, point_desc=desc, frames=frames, intr=intr)


def observe(scene: Scene, frame: Frame, px_noise=0.0, desc_noise=0.02, seed=0,
            intr: Intrinsics | None = None):
    """프레임에서 보이는 점들의 관측 생성.

    반환: (kp N×2, desc N×128, point_ids N, z_true N)
    intr 를 주면 그 intrinsics 로 '측정'한다 (fx 오차 실험용 — 투영은 항상 참값).
    """
    rng = np.random.default_rng(seed * 7919 + frame.index)
    K_true = scene.intr.K()
    R_cv, t_cv = geometry.world_to_cv_extrinsics(frame.R_wc, frame.c)
    uv, z = geometry.project(K_true, R_cv, t_cv, scene.points)
    w, h = scene.intr.width, scene.intr.height
    vis = (z > 0.3) & (uv[:, 0] >= 0) & (uv[:, 0] < w) & (uv[:, 1] >= 0) & (uv[:, 1] < h)
    ids = np.where(vis)[0]
    kp = uv[ids] + rng.normal(0, px_noise, (len(ids), 2)) if px_noise > 0 else uv[ids].copy()
    d = scene.point_desc[ids] + rng.normal(0, desc_noise, (len(ids), DESC_DIM)).astype(np.float32)
    d = (d / np.linalg.norm(d, axis=1, keepdims=True)).astype(np.float32)
    return kp.astype(np.float32), d, ids, z[ids]


class QueueProvider:
    """extract() 호출마다 미리 준비된 (kp, desc) 를 순서대로 돌려준다."""

    def __init__(self, items):
        self.items = list(items)

    def extract(self, gray):
        return self.items.pop(0)


class ConstProvider:
    """항상 같은 (kp, desc) — 측위 질의용."""

    def __init__(self, kp, desc):
        self.kp, self.desc = kp, desc

    def extract(self, gray):
        return self.kp, self.desc
