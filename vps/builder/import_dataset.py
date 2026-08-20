"""iOS 캡처(zip/폴더) → data/datasets/ 가져오기 + 검증.

사용:
  python -m vps.builder.import_dataset path/to/cap_20260820_143000.zip
  python -m vps.builder.import_dataset path/to/cap_folder --datasets-dir data/datasets
"""
from __future__ import annotations

import argparse
import shutil
import sys
import zipfile
from pathlib import Path

import numpy as np

from ..common.dataset import Dataset


def _extract(src: Path, datasets_dir: Path) -> Path:
    """zip 이면 풀고, 폴더면 복사(이미 datasets_dir 안이면 그대로). manifest 루트를 돌려준다."""
    if src.suffix.lower() == ".zip":
        dest = datasets_dir / src.stem
        if dest.exists():
            raise FileExistsError(f"이미 존재함: {dest} — 지우고 다시 실행할 것")
        with zipfile.ZipFile(src) as z:
            z.extractall(dest)
        # zip 안에 폴더가 한 겹 더 있으면(파일 앱 "압축" 이 그렇다) 안쪽을 루트로
        inner = [p for p in dest.iterdir() if p.is_dir()]
        if not (dest / "manifest.json").exists() and len(inner) == 1 \
                and (inner[0] / "manifest.json").exists():
            return inner[0]
        return dest

    if not (src / "manifest.json").exists():
        raise FileNotFoundError(f"manifest.json 이 없음: {src}")
    if datasets_dir.resolve() in src.resolve().parents:
        return src
    dest = datasets_dir / src.name
    if dest.exists():
        raise FileExistsError(f"이미 존재함: {dest}")
    shutil.copytree(src, dest)
    return dest


def validate(root: Path) -> dict:
    ds = Dataset.load(root)
    n = len(ds.frames)
    with_depth = sum(1 for f in ds.frames if f.depth_path is not None)

    # 앞쪽 몇 프레임의 깊이 커버리지 표본 조사
    coverage = []
    for f in ds.frames[: min(5, n)]:
        depth, conf = f.load_depth()
        if depth is None:
            continue
        valid = depth > 0
        if conf is not None:
            valid &= conf >= 1
        coverage.append(valid.mean())

    centers = np.array([f.c for f in ds.frames])
    path_len = float(np.linalg.norm(np.diff(centers, axis=0), axis=1).sum())
    extent = centers.max(axis=0) - centers.min(axis=0)

    return {
        "name": ds.name, "source": ds.source, "units": ds.units,
        "frames": n, "withDepth": with_depth,
        "depthCoverage": float(np.mean(coverage)) if coverage else None,
        "pathLenM": round(path_len, 1),
        "extentM": [round(float(v), 1) for v in extent],
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description="캡처 데이터셋 가져오기 + 검증")
    ap.add_argument("src", help="zip 파일 또는 캡처 폴더")
    ap.add_argument("--datasets-dir", default="data/datasets")
    args = ap.parse_args(argv)

    datasets_dir = Path(args.datasets_dir)
    datasets_dir.mkdir(parents=True, exist_ok=True)
    root = _extract(Path(args.src), datasets_dir)
    print(f"[import] 위치: {root}")

    v = validate(root)
    print(f"[import] {v['name']} ({v['source']}, units={v['units']})")
    print(f"[import] 프레임 {v['frames']}개 (깊이 있음 {v['withDepth']}개)")
    if v["depthCoverage"] is not None:
        print(f"[import] 깊이 커버리지(표본) {v['depthCoverage']*100:.0f}%")
    print(f"[import] 동선 길이 ~{v['pathLenM']}m, 범위 {v['extentM']} m")

    if v["frames"] < 30:
        print("[import] ⚠ 프레임이 적다 — 룸스케일은 80~150장 권장")
    if v["withDepth"] == 0:
        print("[import] ⚠ 깊이가 하나도 없음 — 삼각측량 폴백만으로 빌드된다")

    print(f"\n다음 명령으로 빌드:\n  python -m vps.builder.build_map {root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
