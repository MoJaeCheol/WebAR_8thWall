"""맵 빌더 오케스트레이션.

사용:
  python -m vps.builder.build_map data/datasets/<name> [--maps-dir data/maps]

파이프라인:
  특징 추출(SIFT+rootSIFT, 최대 변 1280) → 쌍 선택 → ratio 매칭 + 에피폴라 필터
  → union-find 트랙 → 깊이 역투영(1급) / 삼각측량(폴백) → 재투영 검증
  → (입력 B 만) fx 그리드 서치 → npz + PLY + maps.json 등록
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

from ..common import geometry
from ..common.dataset import Dataset
from ..common.mapio import MapData, export_ply, register_map, save_map
from . import matching, refine
from .features import EXTRACT_MAX_DIM, SiftProvider, extract_scale
from .triangulate import (FrameFeatures, build_tracks, pick_descriptors,
                          solve_track, validate_track)


def _log(msg: str):
    print(f"[build] {msg}", flush=True)


def extract_all(ds: Dataset, provider) -> list[FrameFeatures]:
    """전 프레임 특징 추출. 추출 해상도로 다운스케일하고 intrinsics 도 함께 줄인다."""
    out = []
    for fr in ds.frames:
        gray = fr.load_image_gray()
        s = extract_scale(fr.intr.width, fr.intr.height)
        if s < 1.0:
            import cv2
            gray = cv2.resize(gray, (round(gray.shape[1] * s), round(gray.shape[0] * s)),
                              interpolation=cv2.INTER_AREA)
        kp, desc = provider.extract(gray)
        h, w = gray.shape[:2]
        ui = np.clip(kp[:, 0].round().astype(int), 0, w - 1)
        vi = np.clip(kp[:, 1].round().astype(int), 0, h - 1)
        out.append(FrameFeatures(
            frame=fr, kp=kp, desc=desc, K=fr.intr.scaled(s).K(), scale=s,
            kp_gray=gray[vi, ui] if len(kp) else np.zeros(0, dtype=np.uint8),
        ))
    return out


def match_all(ff: list[FrameFeatures], pairs, epi_thresh: float = 3.0) -> dict:
    """쌍별 ratio 매칭 + 포즈 기지 에피폴라 필터.

    epi_thresh: 입력 B(intrinsics 가정)는 fx 오차가 에피폴라 거리를 부풀리므로
    느슨하게(12px) 시작해야 참 대응이 살아남는다. 입력 A는 3px.
    """
    pair_matches = {}
    for (a, b) in pairs:
        A, B = ff[a], ff[b]
        m = matching.match_descriptors(A.desc, B.desc)
        if len(m) == 0:
            continue
        F = matching.fundamental_from_poses(A.K, A.R_cv, A.t_cv, B.K, B.R_cv, B.t_cv)
        keep = matching.epipolar_filter(F, A.kp[m[:, 0]], B.kp[m[:, 1]], thresh_px=epi_thresh)
        if keep.any():
            pair_matches[(a, b)] = m[keep]
    return pair_matches


def build(ds: Dataset, provider=None, min_obs: int = 2):
    """반환: (MapData, stats dict)."""
    t0 = time.time()
    provider = provider or SiftProvider()

    ff = extract_all(ds, provider)
    n_kp = sum(len(f.kp) for f in ff)
    _log(f"프레임 {len(ff)}개, 특징점 총 {n_kp:,}개")

    tri_frames = {i for i, f in enumerate(ff) if not f.frame.rot_only}
    pairs = matching.select_pairs([ff[i].frame for i in range(len(ff))])
    pairs = [(a, b) for (a, b) in pairs if a in tri_frames or b in tri_frames]
    assumed = ds.intrinsics_reliability.startswith("assumed")
    pair_matches = match_all(ff, pairs, epi_thresh=12.0 if assumed else 3.0)
    n_match = sum(len(m) for m in pair_matches.values())
    _log(f"쌍 {len(pairs)}개 중 {len(pair_matches)}개에서 매치 {n_match:,}개 (에피폴라 필터 후)")

    tracks = [t for t in build_tracks([len(f.kp) for f in ff], pair_matches)
              if len(t) >= min_obs]
    _log(f"트랙 {len(tracks):,}개 (관측 ≥{min_obs})")

    # 입력 B: fx 정밀화 후 K 갱신 → 이후 단계가 보정된 K 로 돈다
    fx_mult = 1.0
    if assumed and tracks:
        fx_mult, curve = refine.refine_fx(ff, tracks)
        if curve:
            lo = min(c[1] for c in curve)
            _log(f"fx 그리드 서치 → 배수 {fx_mult:.3f} (중앙 재투영 {lo:.2f}px)")
            for f in ff:
                f.K[0, 0] *= fx_mult
                f.K[1, 1] *= fx_mult

    pts, cols, descs, ids, sources = [], [], [], [], {"depth": 0, "tri": 0}
    dropped = {"solve": 0, "validate": 0}
    for tr in tracks:
        X, src = solve_track(tr, ff)
        if X is None:
            dropped["solve"] += 1
            continue
        if not validate_track(X, tr, ff):
            dropped["validate"] += 1
            continue
        pid = len(pts)
        pts.append(X)
        g = int(np.mean([ff[fi].kp_gray[ki] for fi, ki in tr]))
        cols.append([g, g, g])
        for d in pick_descriptors(tr, ff):
            descs.append(d)
            ids.append(pid)
        sources[src] += 1

    if not pts:
        raise RuntimeError("맵 포인트가 0개 — 캡처 품질/포즈를 확인할 것")

    stats = {
        "frames": len(ff), "keypoints": n_kp, "pairs": len(pair_matches),
        "matches": n_match, "tracks": len(tracks),
        "points": len(pts), "descriptors": len(descs),
        "fromDepth": sources["depth"], "fromTriangulation": sources["tri"],
        "dropped": dropped, "fxMultiplier": fx_mult,
        "buildSeconds": round(time.time() - t0, 1),
    }
    meta = {
        "version": 1, "name": ds.name, "source": ds.source, "units": ds.units,
        "axes": "gl-yup-rh; points in world; camera looks -Z",
        "extractMaxDim": EXTRACT_MAX_DIM, "stats": stats,
    }
    m = MapData(
        points_xyz=np.array(pts, dtype=np.float32),
        points_rgb=np.array(cols, dtype=np.uint8),
        descriptors=np.array(descs, dtype=np.float32),
        desc_point_ids=np.array(ids, dtype=np.int32),
        meta=meta,
    )
    _log(f"포인트 {len(pts):,}개 (깊이 {sources['depth']:,} / 삼각측량 {sources['tri']:,}) "
         f"· 탈락 {dropped} · {stats['buildSeconds']}s")
    return m, stats


def main(argv=None):
    ap = argparse.ArgumentParser(description="데이터셋 → VPS 맵 빌드")
    ap.add_argument("dataset", help="data/datasets/<name> 경로")
    ap.add_argument("--maps-dir", default="data/maps")
    ap.add_argument("--min-obs", type=int, default=2)
    args = ap.parse_args(argv)

    ds = Dataset.load(args.dataset)
    _log(f"데이터셋 {ds.name} ({ds.source}, units={ds.units})")
    m, _ = build(ds, min_obs=args.min_obs)

    maps_dir = Path(args.maps_dir)
    maps_dir.mkdir(parents=True, exist_ok=True)
    npz = f"{ds.name}.npz"
    ply = f"{ds.name}.ply"
    save_map(maps_dir / npz, m)
    export_ply(maps_dir / ply, m.points_xyz, m.points_rgb)
    map_id = register_map(maps_dir, ds.name, npz, ply, m.num_points, ds.units)
    _log(f"저장: {maps_dir / npz} · {maps_dir / ply}")
    _log(f"맵 ID = {map_id} (maps.json 등록). 측위 서버를 재시작하면 로드된다")
    return 0


if __name__ == "__main__":
    sys.exit(main())
