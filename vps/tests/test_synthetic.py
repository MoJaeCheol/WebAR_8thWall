"""합성 E2E 테스트 — 폰 없이 기하·규약·파이프라인을 봉인한다.

실행 (repo 루트): python -m pytest vps/tests -q
"""
from __future__ import annotations

import json

import numpy as np
import pytest

from ..builder import build_map, matching, refine
from ..builder.triangulate import FrameFeatures, build_tracks, solve_track, validate_track
from ..common import geometry, mapio
from ..common.dataset import Dataset
from ..server.localizer import Localizer
from .synth import ConstProvider, QueueProvider, look_at_pose, make_scene, observe


# ── 1. 기하 왕복 ──────────────────────────────────────────

def test_pose_roundtrips():
    rng = np.random.default_rng(1)
    for _ in range(20):
        c = rng.uniform(-5, 5, 3)
        R = look_at_pose(c, rng.uniform(-2, 2, 3))
        # manifest 왕복
        R2, c2 = geometry.pose_from_manifest(geometry.pose_to_manifest(R, c))
        assert np.allclose(R, R2) and np.allclose(c, c2)
        # GL ↔ CV 외부파라미터 왕복
        R_cv, t_cv = geometry.world_to_cv_extrinsics(R, c)
        R3, c3 = geometry.cv_extrinsics_to_gl_pose(R_cv, t_cv)
        assert np.allclose(R, R3, atol=1e-10) and np.allclose(c, c3, atol=1e-10)


def test_project_backproject_roundtrip():
    scene = make_scene(n_points=100, n_cams=4)
    K = scene.intr.K()
    f = scene.frames[0]
    R_cv, t_cv = geometry.world_to_cv_extrinsics(f.R_wc, f.c)
    uv, z = geometry.project(K, R_cv, t_cv, scene.points)
    vis = z > 0
    X = geometry.backproject(K, uv[vis], z[vis], f.R_wc, f.c)
    assert np.abs(X - scene.points[vis]).max() < 1e-9


def test_response_client_convention_identity():
    """서버 응답 → 웹 클라이언트 규약 0번 수식 재현 → 루트가 항등이어야 한다.

    클라이언트: T_track_map = T_track_cam · inv(T_map_cam).
    트래킹 프레임 ≡ 맵 프레임이면(같은 좌표계) 루트는 항등이다.
    """
    rng = np.random.default_rng(2)
    for _ in range(10):
        c = rng.uniform(-5, 5, 3)
        R = look_at_pose(c, rng.uniform(-2, 2, 3))
        resp = geometry.gl_pose_to_response(R, c)

        # 클라이언트 규약 0번: M.set(r00..) 그대로 (row-major), pre=post=I
        M = np.eye(4)
        M[:3, :3], M[:3, 3] = geometry.response_to_gl_pose(resp)
        T_track_cam = np.eye(4)
        T_track_cam[:3, :3], T_track_cam[:3, 3] = R, c
        root = T_track_cam @ np.linalg.inv(M)
        assert np.allclose(root, np.eye(4), atol=1e-10)


# ── 2. 파이프라인 (매칭 → 트랙 → 3D) ─────────────────────

def _make_ff(scene, px_noise=0.0, depth="none", depth_noise=0.0, K_override=None, seed=0):
    """관측 생성 → FrameFeatures 목록. depth: 'true'|'none'."""
    ff, gt_ids = [], []
    for fr in scene.frames:
        kp, desc, ids, z = observe(scene, fr, px_noise=px_noise, seed=seed)
        if depth == "true":
            rng = np.random.default_rng(fr.index + 100)
            kd = z + (rng.normal(0, depth_noise, len(z)) if depth_noise else 0)
        else:
            kd = np.full(len(kp), np.nan)
        ff.append(FrameFeatures(frame=fr, kp=kp, desc=desc,
                                K=(K_override if K_override is not None else scene.intr.K()).copy(),
                                scale=1.0, kp_depth=kd))
        gt_ids.append(ids)
    return ff, gt_ids


def _solve_all(ff, gt_ids, epi_thresh=3.0):
    """매칭 → 트랙 → 3D. 반환 [(X, 참점ID, source), ...] (검증 통과분만)."""
    pairs = matching.select_pairs([f.frame for f in ff])
    pm = build_map.match_all(ff, pairs, epi_thresh=epi_thresh)
    tracks = build_tracks([len(f.kp) for f in ff], pm)
    out = []
    for tr in tracks:
        X, src = solve_track(tr, ff)
        if X is None or not validate_track(X, tr, ff):
            continue
        tid = [gt_ids[fi][ki] for fi, ki in tr]
        vals, counts = np.unique(tid, return_counts=True)
        out.append((X, int(vals[np.argmax(counts)]), src, counts.max() / len(tid)))
    return out, tracks


def test_depth_backprojection_exact():
    scene = make_scene(n_points=300, n_cams=12, seed=3)
    ff, gt = _make_ff(scene, depth="true")
    solved, tracks = _solve_all(ff, gt)
    assert len(solved) > 150, f"복원 점이 너무 적음: {len(solved)}/{len(tracks)}"
    errs = [np.linalg.norm(X - scene.points[tid]) for X, tid, src, purity in solved
            if purity == 1.0]
    assert np.median(errs) < 1e-6
    assert all(src == "depth" for _, _, src, _ in solved)


def test_depth_backprojection_noisy():
    scene = make_scene(n_points=300, n_cams=12, seed=4)
    ff, gt = _make_ff(scene, px_noise=0.5, depth="true", depth_noise=0.01, seed=4)
    solved, _ = _solve_all(ff, gt)
    assert len(solved) > 100
    errs = [np.linalg.norm(X - scene.points[tid]) for X, tid, _, p in solved if p == 1.0]
    assert np.median(errs) < 0.02, f"중앙 오차 {np.median(errs):.4f}m"


def test_triangulation_exact():
    scene = make_scene(n_points=300, n_cams=12, seed=5)
    ff, gt = _make_ff(scene, depth="none")
    solved, tracks = _solve_all(ff, gt)
    assert len(solved) > 150
    errs = [np.linalg.norm(X - scene.points[tid]) for X, tid, _, p in solved if p == 1.0]
    assert np.median(errs) < 1e-3
    assert all(src == "tri" for _, _, src, _ in solved)


def test_triangulation_noisy():
    scene = make_scene(n_points=300, n_cams=12, seed=6)
    ff, gt = _make_ff(scene, px_noise=0.5, depth="none", seed=6)
    solved, _ = _solve_all(ff, gt)
    assert len(solved) > 100
    errs = [np.linalg.norm(X - scene.points[tid]) for X, tid, _, p in solved if p == 1.0]
    assert np.median(errs) < 0.01, f"중앙 오차 {np.median(errs):.4f}m"


# ── 3. fx 그리드 서치 (입력 B) ────────────────────────────

def test_fx_grid_search_recovers_truth():
    scene = make_scene(n_points=300, n_cams=12, seed=7)
    wrong = 1.15  # 빌더가 참 fx 의 1.15배로 잘못 알고 있는 상황
    K_wrong = scene.intr.K().copy()
    K_wrong[0, 0] *= wrong
    K_wrong[1, 1] *= wrong
    ff, gt = _make_ff(scene, depth="none", K_override=K_wrong)

    # 트랙은 정답 대응으로 직접 구성 (그리드 서치 자체를 고립 검증)
    per_point: dict[int, list[tuple[int, int]]] = {}
    for fi, ids in enumerate(gt):
        for ki, pid in enumerate(ids):
            per_point.setdefault(int(pid), []).append((fi, ki))
    tracks = [obs for obs in per_point.values() if len(obs) >= 3]

    mult, curve = refine.refine_fx(ff, tracks, max_tracks=400)
    assert curve, "오차 곡선이 비어 있음"
    assert abs(mult * wrong - 1.0) < 0.03, f"복원 배수 {mult:.3f} × {wrong} = {mult*wrong:.3f}"


# ── 4. 맵 IO + PLY ───────────────────────────────────────

def test_mapio_roundtrip_and_ply(tmp_path):
    rng = np.random.default_rng(8)
    m = mapio.MapData(
        points_xyz=rng.uniform(-3, 3, (50, 3)).astype(np.float32),
        points_rgb=rng.integers(0, 255, (50, 3)).astype(np.uint8),
        descriptors=rng.standard_normal((120, 128)).astype(np.float32),
        desc_point_ids=rng.integers(0, 50, 120).astype(np.int32),
        meta={"name": "t", "units": "meters"},
    )
    mapio.save_map(tmp_path / "t.npz", m)
    m2 = mapio.load_map(tmp_path / "t.npz")
    assert np.allclose(m.points_xyz, m2.points_xyz)
    assert np.array_equal(m.desc_point_ids, m2.desc_point_ids)
    assert m2.meta["units"] == "meters"

    mapio.export_ply(tmp_path / "t.ply", m.points_xyz, m.points_rgb)
    raw = (tmp_path / "t.ply").read_bytes()
    head, _, body = raw.partition(b"end_header\n")
    assert b"format binary_little_endian 1.0" in head
    assert head.index(b"property float x") < head.index(b"property uchar red")
    assert len(body) == 50 * (3 * 4 + 3)  # ply.js 가 계산할 stride 와 일치

    map_id = mapio.register_map(tmp_path, "t", "t.npz", "t.ply", 50, "meters")
    assert map_id == mapio.MAP_ID_BASE
    assert mapio.register_map(tmp_path, "t", "t.npz", "t.ply", 50, "meters") == map_id  # 재사용


# ── 5. 측위 + JSON 왕복 ──────────────────────────────────

def _make_map_from_scene(scene, tmp_path, name="synthmap"):
    m = mapio.MapData(
        points_xyz=scene.points.astype(np.float32),
        points_rgb=np.full((len(scene.points), 3), 128, dtype=np.uint8),
        descriptors=scene.point_desc,
        desc_point_ids=np.arange(len(scene.points), dtype=np.int32),
        meta={"name": name, "units": "meters"},
    )
    mapio.save_map(tmp_path / f"{name}.npz", m)
    return tmp_path / f"{name}.npz"


def _query_frame(scene, seed=9):
    from ..common.dataset import Frame
    c = np.array([3.8, 1.5, 1.0])
    return Frame(index=999, image_path=None, depth_path=None, conf_path=None,
                 depth_size=None, R_wc=look_at_pose(c, np.array([0, 1.5, 0.0])),
                 c=c, intr=scene.intr)


@pytest.mark.parametrize("px_noise,tol_pos,tol_deg", [(0.0, 1e-3, 0.01), (0.5, 0.01, 0.1)])
def test_localization(tmp_path, px_noise, tol_pos, tol_deg):
    scene = make_scene(n_points=500, n_cams=8, seed=10)
    npz = _make_map_from_scene(scene, tmp_path)

    q = _query_frame(scene)
    kp, desc, ids, _ = observe(scene, q, px_noise=px_noise, seed=11)
    assert len(kp) > 50

    loc = Localizer(provider=ConstProvider(kp, desc))
    loc.add_map(1000001, "synth", npz)
    r = loc.localize(np.zeros((8, 8), np.uint8),
                     scene.intr.fx, scene.intr.fy, scene.intr.cx, scene.intr.cy)
    assert r["success"], r
    assert r["map"] == 1000001
    assert r["inliers"] >= 30

    R_est, c_est = geometry.response_to_gl_pose(r)
    assert np.linalg.norm(c_est - q.c) < tol_pos, f"위치 오차 {np.linalg.norm(c_est - q.c)}"
    ang = np.degrees(np.arccos(np.clip((np.trace(R_est.T @ q.R_wc) - 1) / 2, -1, 1)))
    assert ang < tol_deg, f"회전 오차 {ang}°"

    # JSON 왕복: 클라이언트 규약 0번 수식으로 루트 = 항등 (트래킹 ≡ 맵일 때)
    M = np.eye(4)
    M[:3, :3], M[:3, 3] = R_est, c_est
    T_cam = np.eye(4)
    T_cam[:3, :3], T_cam[:3, 3] = q.R_wc, q.c
    root = T_cam @ np.linalg.inv(M)
    assert np.allclose(root, np.eye(4), atol=max(tol_pos * 3, 1e-9))


# ── 6. 디스크 E2E (manifest → build → 저장 → 측위) ────────

def test_end_to_end_disk(tmp_path):
    import cv2
    scene = make_scene(n_points=400, n_cams=8, seed=12, fx=550.0, width=640, height=360)
    ds_dir = tmp_path / "dataset"
    (ds_dir / "frames").mkdir(parents=True)
    (ds_dir / "depth").mkdir()

    rng = np.random.default_rng(13)
    frames_json, provider_items = [], []
    for fr in scene.frames:
        kp, desc, ids, z = observe(scene, fr, seed=13)
        img = rng.integers(0, 255, (360, 640), dtype=np.uint8)
        cv2.imwrite(str(ds_dir / "frames" / f"{fr.index:06d}.png"), img)

        depth = np.zeros((360, 640), dtype="<f4")
        u = np.clip(kp[:, 0].round().astype(int), 0, 639)
        v = np.clip(kp[:, 1].round().astype(int), 0, 359)
        depth[v, u] = z.astype(np.float32)
        depth.tofile(ds_dir / "depth" / f"{fr.index:06d}.f32")

        frames_json.append({
            "image": f"frames/{fr.index:06d}.png",
            "depth": f"depth/{fr.index:06d}.f32",
            "depthConfidence": None, "depthSize": [640, 360],
            "pose": geometry.pose_to_manifest(fr.R_wc, fr.c),
            "intrinsics": {"fx": 550.0, "fy": 550.0, "cx": 320.0, "cy": 180.0,
                           "width": 640, "height": 360},
            "t": fr.t, "rotOnly": False,
        })
        provider_items.append((kp, desc))

    (ds_dir / "manifest.json").write_text(json.dumps({
        "version": 1, "name": "e2e", "source": "arkit-lidar", "units": "meters",
        "axes": "gl-yup-rh; pose=T_world_cam row-major; camera looks -Z",
        "intrinsicsReliability": "device-reported", "frames": frames_json,
    }), encoding="utf-8")

    ds = Dataset.load(ds_dir)
    m, stats = build_map.build(ds, provider=QueueProvider(provider_items))
    assert stats["fromDepth"] > 100, stats
    assert stats["fxMultiplier"] == 1.0  # device-reported 는 fx 서치 안 함

    maps_dir = tmp_path / "maps"
    maps_dir.mkdir()
    mapio.save_map(maps_dir / "e2e.npz", m)
    mapio.export_ply(maps_dir / "e2e.ply", m.points_xyz, m.points_rgb)
    map_id = mapio.register_map(maps_dir, "e2e", "e2e.npz", "e2e.ply", m.num_points, "meters")

    q = _query_frame(scene)
    kp, desc, _, _ = observe(scene, q, seed=14)
    loc = Localizer(provider=ConstProvider(kp, desc))
    assert loc.load_registry(maps_dir) == [map_id]
    r = loc.localize(np.zeros((8, 8), np.uint8), 550.0, 550.0, 320.0, 180.0)
    assert r["success"], r
    _, c_est = geometry.response_to_gl_pose(r)
    assert np.linalg.norm(c_est - q.c) < 0.02, f"위치 오차 {np.linalg.norm(c_est - q.c):.4f}m"
