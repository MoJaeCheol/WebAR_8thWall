"""데이터셋(manifest) 로더 — 입력 A(arkit-lidar)/B(web-8thwall) 공용.

manifest.json 형식 (버전 1):
{
  "version": 1,
  "name": "office_20260820a",
  "source": "arkit-lidar" | "web-8thwall",
  "units": "meters" | "slam",
  "axes": "gl-yup-rh; pose=T_world_cam row-major; camera looks -Z",
  "intrinsicsReliability": "device-reported" | "assumed-fov64",
  "frames": [{
    "image": "frames/000042.jpg",
    "depth": "depth/000042.f32" | null,        # w*h float32 LE, 미터 z-깊이
    "depthConfidence": "depth/000042.conf" | null,  # w*h uint8 (0/1/2 = low/med/high)
    "depthSize": [256, 192] | null,             # [width, height]
    "pose": [16 floats row-major T_world_cam],
    "intrinsics": {"fx","fy","cx","cy","width","height"},  # image 해상도 기준
    "t": 12.34, "rotOnly": false
  }]
}
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import geometry

# ARKit ARConfidenceLevel: 0=low, 1=medium, 2=high. medium 이상만 신뢰.
MIN_DEPTH_CONFIDENCE = 1


@dataclass
class Intrinsics:
    fx: float
    fy: float
    cx: float
    cy: float
    width: int
    height: int

    def K(self) -> np.ndarray:
        return geometry.K_matrix(self.fx, self.fy, self.cx, self.cy)

    def scaled(self, s: float) -> "Intrinsics":
        """이미지를 s 배로 리사이즈했을 때의 intrinsics."""
        return Intrinsics(self.fx * s, self.fy * s, self.cx * s, self.cy * s,
                          round(self.width * s), round(self.height * s))


@dataclass
class Frame:
    index: int
    image_path: Path | None
    depth_path: Path | None
    conf_path: Path | None
    depth_size: tuple[int, int] | None   # (width, height)
    R_wc: np.ndarray                     # GL camera-to-world 회전
    c: np.ndarray                        # 카메라 중심 (월드)
    intr: Intrinsics
    t: float = 0.0
    rot_only: bool = False
    # 테스트용: 디스크 없이 배열을 직접 주입할 수 있다
    image: np.ndarray | None = field(default=None, repr=False)
    depth: np.ndarray | None = field(default=None, repr=False)
    depth_conf: np.ndarray | None = field(default=None, repr=False)

    def load_image_gray(self) -> np.ndarray:
        if self.image is not None:
            return self.image
        import cv2
        img = cv2.imread(str(self.image_path), cv2.IMREAD_GRAYSCALE)
        if img is None:
            raise IOError(f"이미지를 읽을 수 없음: {self.image_path}")
        return img

    def load_depth(self) -> tuple[np.ndarray | None, np.ndarray | None]:
        """(depth float32 H×W 미터, conf uint8 H×W 또는 None). 깊이가 없으면 (None, None)."""
        if self.depth is not None:
            return self.depth, self.depth_conf
        if self.depth_path is None:
            return None, None
        w, h = self.depth_size
        d = np.fromfile(self.depth_path, dtype="<f4")
        if d.size != w * h:
            raise ValueError(f"깊이 크기 불일치: {self.depth_path} ({d.size} != {w}*{h})")
        depth = d.reshape(h, w)
        conf = None
        if self.conf_path is not None and Path(self.conf_path).exists():
            cbuf = np.fromfile(self.conf_path, dtype=np.uint8)
            if cbuf.size == w * h:
                conf = cbuf.reshape(h, w)
        return depth, conf

    def depth_at(self, uv: np.ndarray) -> np.ndarray:
        """이미지 픽셀 좌표 (N×2, intrinsics.width/height 기준) → z-깊이(m). 무효는 NaN.

        깊이맵(예: 256×192)은 RGB 와 같은 화각·주점 비율이므로 좌표를 해상도
        비례로 축소해 최근접 조회한다. confidence < medium 이거나 범위 밖은 NaN.
        """
        depth, conf = self.load_depth()
        if depth is None:
            return np.full(len(uv), np.nan)
        h, w = depth.shape
        sx = w / self.intr.width
        sy = h / self.intr.height
        u = np.round(uv[:, 0] * sx).astype(int)
        v = np.round(uv[:, 1] * sy).astype(int)
        ok = (u >= 0) & (u < w) & (v >= 0) & (v < h)
        out = np.full(len(uv), np.nan)
        ui, vi = u[ok], v[ok]
        z = depth[vi, ui].astype(np.float64)
        z[z <= 0] = np.nan
        if conf is not None:
            z[conf[vi, ui] < MIN_DEPTH_CONFIDENCE] = np.nan
        out[ok] = z
        return out


@dataclass
class Dataset:
    name: str
    source: str
    units: str
    intrinsics_reliability: str
    frames: list[Frame]
    root: Path | None = None

    @property
    def metric(self) -> bool:
        return self.units == "meters"

    @staticmethod
    def load(root: str | Path) -> "Dataset":
        root = Path(root)
        mf_path = root / "manifest.json"
        mf = json.loads(mf_path.read_text(encoding="utf-8"))
        if mf.get("version") != 1:
            raise ValueError(f"지원하지 않는 manifest 버전: {mf.get('version')}")

        frames = []
        for i, f in enumerate(mf["frames"]):
            R_wc, c = geometry.pose_from_manifest(f["pose"])
            ii = f["intrinsics"]
            intr = Intrinsics(ii["fx"], ii["fy"], ii["cx"], ii["cy"],
                              int(ii["width"]), int(ii["height"]))
            img = root / f["image"]
            if not img.exists():
                raise FileNotFoundError(f"프레임 이미지 없음: {img}")
            depth_path = root / f["depth"] if f.get("depth") else None
            if depth_path is not None and not depth_path.exists():
                raise FileNotFoundError(f"깊이 파일 없음: {depth_path}")
            conf_path = root / f["depthConfidence"] if f.get("depthConfidence") else None
            ds = tuple(f["depthSize"]) if f.get("depthSize") else None
            if depth_path is not None and ds is None:
                raise ValueError(f"depth 가 있으면 depthSize 필수 (frame {i})")
            frames.append(Frame(
                index=i, image_path=img, depth_path=depth_path, conf_path=conf_path,
                depth_size=ds, R_wc=R_wc, c=c, intr=intr,
                t=float(f.get("t", 0)), rot_only=bool(f.get("rotOnly", False)),
            ))

        if not frames:
            raise ValueError("manifest 에 프레임이 없음")
        return Dataset(
            name=mf["name"], source=mf.get("source", "unknown"),
            units=mf.get("units", "slam"),
            intrinsics_reliability=mf.get("intrinsicsReliability", "assumed-unknown"),
            frames=frames, root=root,
        )
