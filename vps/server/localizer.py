"""측위 코어 — 맵 로드, FLANN 매칭, solvePnPRansac.

응답 포즈는 GL 규약 camera-to-map (geometry.py 참조). 웹 클라이언트는
규약 0번(항등)으로 해석한다.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..common import geometry, mapio
from ..builder.features import SiftProvider

# 실측 통계(2026-08-21, 21질의)에서 19인라이어 정답이 게이트에 걸렸다 → 15로 완화.
# 오수락 위험은 클라이언트의 이상치 거부(1.5m) + 연속 합의 복구가 받친다.
MIN_INLIERS = 15
MIN_INLIER_RATIO = 0.12
RATIO_TEST = 0.8
PNP_REPROJ_PX = 5.0
PNP_ITERS = 2000


@dataclass
class LoadedMap:
    map_id: int
    name: str
    data: mapio.MapData
    matcher: object  # cv2.FlannBasedMatcher (사전 학습된 인덱스)
    ply_path: Path | None


def _build_matcher(descriptors: np.ndarray):
    import cv2
    flann = cv2.FlannBasedMatcher(dict(algorithm=1, trees=4), dict(checks=64))
    flann.add([descriptors])
    flann.train()
    return flann


class Localizer:
    def __init__(self, provider=None):
        self.provider = provider or SiftProvider()
        self.maps: dict[int, LoadedMap] = {}
        # 원격 진단용 누적 통계 — 실패 질의도 "어디까지 갔는지"(특징/매치/인라이어) 남긴다
        self.stats = {"queries": 0, "ok": 0, "fail": {}}
        self.recent: list[dict] = []

    def _record(self, entry: dict) -> None:
        self.stats["queries"] += 1
        if entry.get("success"):
            self.stats["ok"] += 1
        else:
            e = entry.get("error", "?")
            self.stats["fail"][e] = self.stats["fail"].get(e, 0) + 1
        self.recent.append(entry)
        if len(self.recent) > 50:
            self.recent.pop(0)

    def load_registry(self, maps_dir: str | Path) -> list[int]:
        maps_dir = Path(maps_dir)
        reg = mapio.load_registry(maps_dir)
        for k, v in reg.items():
            map_id = int(k)
            npz = maps_dir / v["npz"]
            if not npz.exists():
                print(f"[vps] ⚠ 맵 {map_id} npz 없음: {npz} — 건너뜀")
                continue
            self.add_map(map_id, v.get("name", str(map_id)), npz,
                         maps_dir / v["ply"] if v.get("ply") else None)
        return sorted(self.maps)

    def add_map(self, map_id: int, name: str, npz_path: str | Path,
                ply_path: str | Path | None = None):
        data = mapio.load_map(npz_path)
        self.maps[map_id] = LoadedMap(
            map_id=map_id, name=name, data=data,
            matcher=_build_matcher(data.descriptors), ply_path=Path(ply_path) if ply_path else None)
        print(f"[vps] 맵 {map_id} ({name}) 로드 — 포인트 {data.num_points:,}, "
              f"서술자 {len(data.descriptors):,}")

    def _match_map(self, lm: LoadedMap, desc_q: np.ndarray):
        """질의 서술자 → (2D 인덱스, 3D점) 대응. 같은 3D점 중복은 최소 거리만.

        ⚠ 맵은 포인트당 서술자를 최대 4개 보관하므로, ratio test 의 2등을
        "다른 3D점"의 최단 거리로 잡아야 한다. knn=2 로 하면 1·2등이 같은 점의
        관측들이라 ratio≈1 이 되어 참 대응이 전멸한다 (합성 테스트로 확인).
        """
        pids_all = lm.data.desc_point_ids
        knn = lm.matcher.knnMatch(desc_q, k=6)
        best: dict[int, tuple[float, int]] = {}  # point_id -> (dist, query_idx)
        for cand in knn:
            if not cand:
                continue
            m = cand[0]
            pid = int(pids_all[m.trainIdx])
            other = next((c for c in cand[1:] if int(pids_all[c.trainIdx]) != pid), None)
            if other is not None and m.distance >= RATIO_TEST * other.distance:
                continue
            prev = best.get(pid)
            if prev is None or m.distance < prev[0]:
                best[pid] = (m.distance, m.queryIdx)
        if not best:
            return np.zeros(0, dtype=int), np.zeros((0, 3))
        qidx = np.array([qi for (_, qi) in best.values()], dtype=int)
        pids = np.array(list(best.keys()), dtype=int)
        return qidx, lm.data.points_xyz[pids].astype(np.float64)

    def localize(self, gray: np.ndarray, fx: float, fy: float, ox: float, oy: float,
                 map_ids: list[int] | None = None) -> dict:
        import cv2
        t0 = time.time()
        targets = [self.maps[i] for i in (map_ids or sorted(self.maps)) if i in self.maps]
        if not targets:
            return {"success": False, "error": "no-maps"}

        kp, desc = self.provider.extract(gray)
        if len(kp) < MIN_INLIERS:
            r = {"success": False, "error": "not-enough-features",
                 "features": int(len(kp)), "timeMs": round((time.time() - t0) * 1000)}
            self._record({**r, "t": round(time.time())})
            return r

        K = geometry.K_matrix(fx, fy, ox, oy)
        best = None
        near = {"matches": 0, "inliers": 0}   # 게이트에 걸린 최선의 시도 (진단용)
        for lm in targets:
            qidx, obj = self._match_map(lm, desc)
            near["matches"] = max(near["matches"], len(obj))
            if len(obj) < MIN_INLIERS:
                continue
            img_pts = kp[qidx].astype(np.float64)
            ok, rvec, tvec, inl = cv2.solvePnPRansac(
                obj, img_pts, K, None,
                flags=cv2.SOLVEPNP_EPNP, reprojectionError=PNP_REPROJ_PX,
                iterationsCount=PNP_ITERS, confidence=0.999)
            if not ok or inl is None:
                continue
            inl = inl.ravel()
            near["inliers"] = max(near["inliers"], len(inl))
            if len(inl) < MIN_INLIERS or len(inl) / len(obj) < MIN_INLIER_RATIO:
                continue
            rvec, tvec = cv2.solvePnPRefineLM(obj[inl], img_pts[inl], K, None, rvec, tvec)
            if best is None or len(inl) > best["inliers"]:
                best = {"map": lm.map_id, "rvec": rvec, "tvec": tvec,
                        "inliers": len(inl), "matches": len(obj)}

        ms = round((time.time() - t0) * 1000)
        if best is None:
            r = {"success": False, "error": "not-enough-inliers", "timeMs": ms,
                 "features": int(len(kp)),
                 "nearMatches": near["matches"], "nearInliers": near["inliers"]}
            self._record({**r, "t": round(time.time())})
            return r

        R_cv, _ = cv2.Rodrigues(best["rvec"])
        R_wc, c = geometry.cv_extrinsics_to_gl_pose(R_cv, best["tvec"].ravel())
        resp = {"success": True, "map": best["map"],
                "confidence": int(best["inliers"]),
                "inliers": int(best["inliers"]), "matches": int(best["matches"]),
                "timeMs": ms}
        resp.update(geometry.gl_pose_to_response(R_wc, c))
        self._record({"success": True, "map": best["map"], "features": int(len(kp)),
                      "matches": int(best["matches"]), "inliers": int(best["inliers"]),
                      "px": round(float(c[0]), 2), "py": round(float(c[1]), 2),
                      "pz": round(float(c[2]), 2),
                      "timeMs": ms, "t": round(time.time())})
        return resp
