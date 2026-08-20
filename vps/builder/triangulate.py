"""트랙 구성 + 3D 복원 (깊이 역투영 1급, 삼각측량 폴백) + 필터.

입력 A(LiDAR)에서는 특징점 픽셀의 깊이를 조회해 프레임 1장으로 3D 를 확정한다
(시차 불필요). 같은 물리점을 여러 프레임이 봤으면 역투영 결과들의 중앙값으로
병합해 깊이 노이즈를 누른다. 깊이가 무효(원거리·저신뢰·입력 B)인 트랙만
포즈 기지 삼각측량으로 폴백한다.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from ..common import geometry

MIN_PARALLAX_DEG = 1.5
REPROJ_THRESH_PX = 3.0
REPROJ_OK_RATIO = 0.8
DEPTH_RANGE = (0.2, 50.0)
MAX_DESC_PER_POINT = 4


@dataclass
class FrameFeatures:
    """빌드 파이프라인에서 프레임 하나에 대해 들고 다니는 것들.

    kp/K 는 추출 해상도 기준이고, scale 은 (추출 해상도 / 원본 해상도).
    깊이 조회는 원본 해상도 픽셀이 필요하므로 kp/scale 로 되돌린다.
    """
    frame: object              # common.dataset.Frame
    kp: np.ndarray             # N×2 float32 (추출 해상도)
    desc: np.ndarray           # N×128 float32
    K: np.ndarray              # 3×3 (추출 해상도 기준)
    scale: float
    R_cv: np.ndarray = field(default=None)
    t_cv: np.ndarray = field(default=None)
    kp_depth: np.ndarray = field(default=None)   # N, z-깊이(m) 또는 NaN
    kp_gray: np.ndarray = field(default=None)    # N, 특징점 위치 밝기 (PLY 시각화용)

    def __post_init__(self):
        self.R_cv, self.t_cv = geometry.world_to_cv_extrinsics(self.frame.R_wc, self.frame.c)
        if self.kp_depth is None:
            uv_orig = self.kp / self.scale
            self.kp_depth = self.frame.depth_at(uv_orig)


class UnionFind:
    def __init__(self, n: int):
        self.parent = list(range(n))

    def find(self, a: int) -> int:
        while self.parent[a] != a:
            self.parent[a] = self.parent[self.parent[a]]
            a = self.parent[a]
        return a

    def union(self, a: int, b: int):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def build_tracks(kp_counts: list[int],
                 pair_matches: dict[tuple[int, int], np.ndarray]) -> list[list[tuple[int, int]]]:
    """매치들을 union-find 로 묶어 트랙(같은 물리점의 관측 목록)을 만든다.

    같은 프레임에 서로 다른 keypoint 2개가 들어오는 모순 트랙은 폐기한다.
    반환: [[(frame_idx, kp_idx), ...], ...] — 관측 2개 이상 트랙만.
    """
    offsets = np.concatenate([[0], np.cumsum(kp_counts)])
    uf = UnionFind(int(offsets[-1]))
    for (a, b), m in pair_matches.items():
        for ia, ib in m:
            uf.union(int(offsets[a] + ia), int(offsets[b] + ib))

    groups: dict[int, list[tuple[int, int]]] = {}
    for fi in range(len(kp_counts)):
        for ki in range(kp_counts[fi]):
            gid = uf.find(int(offsets[fi] + ki))
            groups.setdefault(gid, []).append((fi, ki))

    tracks = []
    for obs in groups.values():
        if len(obs) < 2:
            continue
        frames_seen = [o[0] for o in obs]
        if len(set(frames_seen)) != len(frames_seen):
            continue  # 모순 트랙
        tracks.append(sorted(obs))
    return tracks


def _triangulate_pair(fA: FrameFeatures, kA: int, fB: FrameFeatures, kB: int) -> np.ndarray:
    import cv2
    PA = fA.K @ np.hstack([fA.R_cv, fA.t_cv[:, None]])
    PB = fB.K @ np.hstack([fB.R_cv, fB.t_cv[:, None]])
    Xh = cv2.triangulatePoints(PA, PB, fA.kp[kA].reshape(2, 1).astype(np.float64),
                               fB.kp[kB].reshape(2, 1).astype(np.float64))
    return (Xh[:3] / Xh[3]).ravel()


def _ray_world(f: FrameFeatures, k: int) -> np.ndarray:
    """특징점을 지나는 시선 광선의 월드 방향 (단위벡터)."""
    K = f.K
    p_cv = np.array([(f.kp[k][0] - K[0, 2]) / K[0, 0],
                     (f.kp[k][1] - K[1, 2]) / K[1, 1], 1.0])
    d = f.frame.R_wc @ (geometry.F_FLIP @ p_cv)
    return d / np.linalg.norm(d)


def solve_track(track: list[tuple[int, int]], ff: list[FrameFeatures]):
    """트랙 하나의 3D 점. 반환 (X_world, source) — 실패 시 (None, 이유)."""
    depth_pts = []
    for fi, ki in track:
        z = ff[fi].kp_depth[ki]
        if np.isfinite(z) and DEPTH_RANGE[0] < z < DEPTH_RANGE[1]:
            X = geometry.backproject(ff[fi].K, ff[fi].kp[ki][None, :],
                                     np.array([z]), ff[fi].frame.R_wc, ff[fi].frame.c)[0]
            depth_pts.append(X)

    if depth_pts:
        return np.median(np.array(depth_pts), axis=0), "depth"

    # 폴백: 최대 시차각 쌍으로 삼각측량
    best, best_ang = None, 0.0
    for a in range(len(track)):
        for b in range(a + 1, len(track)):
            fa, ka = track[a]
            fb, kb = track[b]
            ang = np.degrees(np.arccos(np.clip(
                _ray_world(ff[fa], ka) @ _ray_world(ff[fb], kb), -1, 1)))
            if ang > best_ang:
                best_ang, best = ang, (fa, ka, fb, kb)
    if best is None or best_ang < MIN_PARALLAX_DEG:
        return None, "low-parallax"
    fa, ka, fb, kb = best
    return _triangulate_pair(ff[fa], ka, ff[fb], kb), "tri"


def validate_track(X: np.ndarray, track: list[tuple[int, int]], ff: list[FrameFeatures]) -> bool:
    """전 관측에서 cheirality + 재투영 오차 + 거리 sanity."""
    ok = 0
    for fi, ki in track:
        f = ff[fi]
        uv, z = geometry.project(f.K, f.R_cv, f.t_cv, X[None, :])
        if z[0] <= 0:
            return False  # 카메라 뒤 — 즉시 탈락
        dist = np.linalg.norm(X - f.frame.c)
        if not (DEPTH_RANGE[0] < dist < DEPTH_RANGE[1]):
            return False
        if np.linalg.norm(uv[0] - f.kp[ki]) < REPROJ_THRESH_PX:
            ok += 1
    return ok >= max(2, int(np.ceil(len(track) * REPROJ_OK_RATIO)))


def pick_descriptors(track: list[tuple[int, int]], ff: list[FrameFeatures]) -> list[np.ndarray]:
    """포인트당 서술자 ≤4개 — 프레임 간격이 고르게 벌어지도록 선택 (시점 다양성 근사)."""
    if len(track) <= MAX_DESC_PER_POINT:
        chosen = track
    else:
        idx = np.linspace(0, len(track) - 1, MAX_DESC_PER_POINT).round().astype(int)
        chosen = [track[i] for i in idx]
    return [ff[fi].desc[ki] for fi, ki in chosen]
