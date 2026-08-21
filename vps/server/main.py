"""자체 VPS 측위 서버 (FastAPI).

실행 (repo 루트에서):
  python -m uvicorn vps.server.main:app --host 127.0.0.1 --port 8000

폰은 이 서버에 직접 붙지 않는다 — 기존 Node HTTPS 서버가
/api/vps/* 를 여기로 프록시한다 (단일 오리진, CORS/TLS 불필요).
"""
from __future__ import annotations

import base64
import os
from pathlib import Path

import numpy as np
from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from .localizer import Localizer

REPO_ROOT = Path(__file__).resolve().parents[2]
MAPS_DIR = Path(os.environ.get("VPS_MAPS_DIR", REPO_ROOT / "data" / "maps"))

app = FastAPI(title="AR_8th self-hosted VPS")
localizer = Localizer()


@app.on_event("startup")
def _startup():
    loaded = localizer.load_registry(MAPS_DIR)
    print(f"[vps] maps dir = {MAPS_DIR} — 맵 {len(loaded)}개 로드: {loaded}")


class LocalizeBody(BaseModel):
    b64: str
    fx: float
    fy: float
    ox: float
    oy: float
    mapIds: list[int] | None = None


@app.post("/localize")
def localize(body: LocalizeBody):
    import cv2
    try:
        raw = base64.b64decode(body.b64)
    except Exception:
        return JSONResponse({"success": False, "error": "bad-b64"}, status_code=400)
    img = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if img is None:
        return JSONResponse({"success": False, "error": "bad-image"}, status_code=400)
    result = localizer.localize(img, body.fx, body.fy, body.ox, body.oy, body.mapIds)
    print(f"[vps] localize {img.shape[1]}x{img.shape[0]} → "
          f"{'맵 ' + str(result.get('map')) + ' inliers ' + str(result.get('inliers')) if result.get('success') else result.get('error')} "
          f"({result.get('timeMs', '-')}ms)")
    return result


@app.get("/health")
def health():
    return {"ok": True, "maps": sorted(localizer.maps)}


@app.get("/stats")
def stats():
    """원격 진단 — 실패 질의의 근접도(nearInliers 등)까지 포함한 누적 통계."""
    return {"stats": localizer.stats, "recent": localizer.recent[-25:]}


@app.get("/maps")
def maps():
    return {str(k): {"name": v.name, "points": v.data.num_points}
            for k, v in localizer.maps.items()}


@app.get("/map/{map_id}/pointcloud.ply")
def pointcloud(map_id: int):
    lm = localizer.maps.get(map_id)
    if lm is None or lm.ply_path is None or not lm.ply_path.exists():
        return JSONResponse({"error": "not-found"}, status_code=404)
    return FileResponse(lm.ply_path, media_type="application/octet-stream")
