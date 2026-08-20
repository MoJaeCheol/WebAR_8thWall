"""프레임 쌍 선택 + 서술자 매칭 + 에피폴라 필터.

포즈를 이미 아는 것이 이 빌더의 최대 무기다:
  - 쌍 선택을 거리·시선각으로 할 수 있고 (전수 매칭 불필요)
  - F 행렬을 포즈에서 직접 계산해, ratio test 를 통과한 오매치를
    에피폴라 거리로 걸러낼 수 있다.
"""
from __future__ import annotations

import numpy as np

from ..common import geometry


def select_pairs(frames, seq_window: int = 5, loop_k: int = 3,
                 max_view_angle_deg: float = 40.0) -> list[tuple[int, int]]:
    """삼각측량·트랙 병합에 쓸 프레임 쌍.

    - 순차 이웃: i ↔ i+1 .. i+seq_window
    - 루프 클로저: 비인접 프레임 중 카메라 중심이 가깝고(중앙값 키프레임 간격×4)
      시선각 차가 max_view_angle_deg 미만인 k-최근접
    """
    n = len(frames)
    pairs = set()
    for i in range(n):
        for j in range(i + 1, min(n, i + 1 + seq_window)):
            pairs.add((i, j))

    if n > seq_window + 1:
        centers = np.array([f.c for f in frames])
        # GL 카메라 시선 = -Z 열
        views = np.array([-f.R_wc[:, 2] for f in frames])
        step = np.linalg.norm(np.diff(centers, axis=0), axis=1)
        med = np.median(step[step > 1e-6]) if np.any(step > 1e-6) else 0.0
        radius = med * 4 if med > 0 else np.inf

        for i in range(n):
            d = np.linalg.norm(centers - centers[i], axis=1)
            ang = np.degrees(np.arccos(np.clip(views @ views[i], -1, 1)))
            cand = [j for j in np.argsort(d)
                    if abs(j - i) > seq_window and d[j] < radius and ang[j] < max_view_angle_deg]
            for j in cand[:loop_k]:
                pairs.add((min(i, int(j)), max(i, int(j))))

    return sorted(pairs)


def match_descriptors(descA: np.ndarray, descB: np.ndarray,
                      ratio: float = 0.8) -> np.ndarray:
    """knn=2 + Lowe ratio. 반환: (M×2) [idxA, idxB]. B 쪽 중복은 최소 거리 하나만."""
    if len(descA) < 2 or len(descB) < 2:
        return np.zeros((0, 2), dtype=np.int32)
    import cv2
    bf = cv2.BFMatcher(cv2.NORM_L2)
    knn = bf.knnMatch(descA, descB, k=2)
    picked = {}  # idxB -> (dist, idxA)
    for pair in knn:
        if len(pair) < 2:
            continue
        m, m2 = pair
        if m.distance < ratio * m2.distance:
            prev = picked.get(m.trainIdx)
            if prev is None or m.distance < prev[0]:
                picked[m.trainIdx] = (m.distance, m.queryIdx)
    if not picked:
        return np.zeros((0, 2), dtype=np.int32)
    return np.array([[ia, ib] for ib, (_, ia) in picked.items()], dtype=np.int32)


def fundamental_from_poses(KA, RA_cv, tA_cv, KB, RB_cv, tB_cv) -> np.ndarray:
    """포즈 기지 F 행렬: xB^T F xA = 0."""
    R_rel = RB_cv @ RA_cv.T
    t_rel = tB_cv - R_rel @ tA_cv
    tx = np.array([[0, -t_rel[2], t_rel[1]],
                   [t_rel[2], 0, -t_rel[0]],
                   [-t_rel[1], t_rel[0], 0]])
    E = tx @ R_rel
    return np.linalg.inv(KB).T @ E @ np.linalg.inv(KA)


def epipolar_filter(F: np.ndarray, ptsA: np.ndarray, ptsB: np.ndarray,
                    thresh_px: float = 3.0) -> np.ndarray:
    """대칭 에피폴라 거리 필터. 반환: bool mask (통과 = True)."""
    if len(ptsA) == 0:
        return np.zeros(0, dtype=bool)
    hA = np.hstack([ptsA, np.ones((len(ptsA), 1))])
    hB = np.hstack([ptsB, np.ones((len(ptsB), 1))])
    lB = hA @ F.T          # A 점이 만드는 B 이미지의 에피폴라 선
    lA = hB @ F            # B 점이 만드는 A 이미지의 에피폴라 선
    num = np.abs(np.sum(hB * lB, axis=1))
    dB = num / (np.linalg.norm(lB[:, :2], axis=1) + 1e-12)
    dA = num / (np.linalg.norm(lA[:, :2], axis=1) + 1e-12)
    return np.maximum(dA, dB) < thresh_px
