"""특징 추출 — SIFT + rootSIFT.

빌더와 측위 서버가 반드시 같은 추출기를 써야 하므로 여기 한 곳에 둔다.
테스트는 SiftProvider 대신 합성 provider 를 주입해 기하 배관만 결정론적으로
검증한다 (extract(frame) -> (kp N×2, desc N×D) 인터페이스만 맞추면 된다).
"""
from __future__ import annotations

import numpy as np

# 질의·빌드 공통 추출 해상도(최대 변). 웹 캡처 해상도와 스케일을 맞춘다.
EXTRACT_MAX_DIM = 1280

SIFT_PARAMS = dict(nfeatures=3000, contrastThreshold=0.03)


def root_sift(desc: np.ndarray) -> np.ndarray:
    """SIFT → rootSIFT: L1 정규화 후 원소별 sqrt. 매칭 품질이 눈에 띄게 좋아진다."""
    if desc is None or len(desc) == 0:
        return np.zeros((0, 128), dtype=np.float32)
    d = desc.astype(np.float32)
    d /= (np.abs(d).sum(axis=1, keepdims=True) + 1e-7)
    return np.sqrt(d)


class SiftProvider:
    """실제 SIFT 추출기. extract 는 (keypoints N×2 float32, rootSIFT N×128) 을 준다."""

    def __init__(self):
        import cv2
        self._cv2 = cv2
        self._sift = cv2.SIFT_create(**SIFT_PARAMS)

    def extract(self, gray: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        kps, desc = self._sift.detectAndCompute(gray, None)
        if not kps:
            return np.zeros((0, 2), dtype=np.float32), np.zeros((0, 128), dtype=np.float32)
        pts = np.array([k.pt for k in kps], dtype=np.float32)
        return pts, root_sift(desc)


def extract_scale(width: int, height: int, max_dim: int = EXTRACT_MAX_DIM) -> float:
    """원본 해상도 → 추출 해상도 배율 (1.0 이하)."""
    long_side = max(width, height)
    return 1.0 if long_side <= max_dim else max_dim / long_side
