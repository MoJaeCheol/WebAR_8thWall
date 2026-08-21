"""빌드된 맵을 PNG 3면도로 렌더 — PLY 육안 검사용 (방 형태가 보여야 정상).

사용:
  python -m vps.builder.preview_map data/maps/<name>.npz [-o out.png]
"""
from __future__ import annotations

import argparse
import sys

import numpy as np

from ..common import mapio


def render(npz_path: str, out_path: str) -> dict:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    m = mapio.load_map(npz_path)
    p = m.points_xyz
    # 시각화 방해 이상치(상하위 1%) 제거
    lo, hi = np.percentile(p, [1, 99], axis=0)
    ok = np.all((p >= lo) & (p <= hi), axis=1)
    q = p[ok]

    fig, axes = plt.subplots(1, 3, figsize=(16, 5.5))
    views = [
        ("Top (X–Z)", q[:, 0], q[:, 2], q[:, 1]),   # 위에서 — 높이로 색
        ("Front (X–Y)", q[:, 0], q[:, 1], q[:, 2]),
        ("Side (Z–Y)", q[:, 2], q[:, 1], q[:, 0]),
    ]
    for ax, (title, x, y, c) in zip(axes, views):
        s = ax.scatter(x, y, c=c, s=0.5, cmap="viridis", alpha=0.6)
        ax.set_title(title)
        ax.set_aspect("equal")
        ax.grid(True, alpha=0.3)
        fig.colorbar(s, ax=ax, shrink=0.7)
    stats = m.meta.get("stats", {})
    fig.suptitle(
        f"{m.meta.get('name')} — {m.num_points:,} points "
        f"(depth {stats.get('fromDepth', '?'):,} / tri {stats.get('fromTriangulation', '?'):,}) "
        f"units={m.meta.get('units')}")
    fig.tight_layout()
    fig.savefig(out_path, dpi=110)

    ext = q.max(axis=0) - q.min(axis=0)
    return {"points": m.num_points, "extentM": [round(float(v), 2) for v in ext]}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("npz")
    ap.add_argument("-o", "--out", default="map_preview.png")
    args = ap.parse_args(argv)
    info = render(args.npz, args.out)
    print(f"[preview] {info['points']:,} points, 범위 {info['extentM']} m → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
