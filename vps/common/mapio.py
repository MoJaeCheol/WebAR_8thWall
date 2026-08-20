"""맵 파일 입출력 — npz(서술자+3D점) 저장/로드, PLY export, maps.json 레지스트리.

PLY 는 웹 클라이언트의 public/js/ply.js 가 파싱하는 형식(binary_little_endian,
float x/y/z + uchar red/green/blue)으로 내보낸다 — 기존 "맵 특징점 겹쳐 보기"
AR 오버레이 디버그를 자체 맵에서도 그대로 쓰기 위함이다.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# Immersal 맵 ID(15xxxx 등)와 충돌하지 않는 자체 맵 ID 시작값
MAP_ID_BASE = 1000001


@dataclass
class MapData:
    points_xyz: np.ndarray      # N×3 float32 (GL 월드 프레임)
    points_rgb: np.ndarray      # N×3 uint8 (시각화용)
    descriptors: np.ndarray     # M×D float32 (rootSIFT)
    desc_point_ids: np.ndarray  # M   int32 — 각 서술자가 가리키는 3D점 인덱스
    meta: dict

    @property
    def num_points(self) -> int:
        return len(self.points_xyz)


def save_map(path: str | Path, m: MapData) -> None:
    np.savez_compressed(
        path,
        points_xyz=m.points_xyz.astype(np.float32),
        points_rgb=m.points_rgb.astype(np.uint8),
        descriptors=m.descriptors.astype(np.float32),
        desc_point_ids=m.desc_point_ids.astype(np.int32),
        meta=np.frombuffer(json.dumps(m.meta, ensure_ascii=False).encode("utf-8"), dtype=np.uint8),
    )


def load_map(path: str | Path) -> MapData:
    z = np.load(path)
    meta = json.loads(bytes(z["meta"]).decode("utf-8"))
    return MapData(
        points_xyz=z["points_xyz"], points_rgb=z["points_rgb"],
        descriptors=z["descriptors"], desc_point_ids=z["desc_point_ids"],
        meta=meta,
    )


def export_ply(path: str | Path, points_xyz: np.ndarray, points_rgb: np.ndarray) -> None:
    n = len(points_xyz)
    header = (
        "ply\n"
        "format binary_little_endian 1.0\n"
        f"element vertex {n}\n"
        "property float x\nproperty float y\nproperty float z\n"
        "property uchar red\nproperty uchar green\nproperty uchar blue\n"
        "end_header\n"
    )
    # 인터리브: [x y z r g b] × N — ply.js 가 property 순서에서 stride 를 계산한다
    rec = np.zeros(n, dtype=[("xyz", "<f4", 3), ("rgb", "u1", 3)])
    rec["xyz"] = points_xyz.astype(np.float32)
    rec["rgb"] = points_rgb.astype(np.uint8)
    with open(path, "wb") as f:
        f.write(header.encode("ascii"))
        f.write(rec.tobytes())


# ── maps.json 레지스트리 ──────────────────────────────────
# { "1000001": {"name": "...", "npz": "office.npz", "ply": "office.ply",
#               "points": 23000, "units": "meters", "created": "..."} }

def _registry_path(maps_dir: Path) -> Path:
    return maps_dir / "maps.json"


def load_registry(maps_dir: str | Path) -> dict:
    p = _registry_path(Path(maps_dir))
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


def register_map(maps_dir: str | Path, name: str, npz_file: str, ply_file: str,
                 num_points: int, units: str) -> int:
    """맵을 레지스트리에 등록하고 숫자 ID 를 돌려준다. 같은 이름이면 ID 재사용."""
    maps_dir = Path(maps_dir)
    maps_dir.mkdir(parents=True, exist_ok=True)
    reg = load_registry(maps_dir)

    map_id = None
    for k, v in reg.items():
        if v.get("name") == name:
            map_id = int(k)
            break
    if map_id is None:
        map_id = max([int(k) for k in reg] + [MAP_ID_BASE - 1]) + 1

    reg[str(map_id)] = {
        "name": name, "npz": npz_file, "ply": ply_file,
        "points": int(num_points), "units": units,
        "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    _registry_path(maps_dir).write_text(
        json.dumps(reg, ensure_ascii=False, indent=2), encoding="utf-8")
    return map_id
