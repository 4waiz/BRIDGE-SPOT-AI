"""HTTP surface for the HSSE labelling tool.

Mounted under /api/labeling by app.py. Sync handlers: the work is filesystem
bound, and FastAPI runs sync handlers in a worker thread so a large export does
not block the robot control endpoints served by the same app.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import labeling
from labeling import LabelingError

router = APIRouter(prefix="/api/labeling", tags=["labeling"])


class Box(BaseModel):
    cls: str = Field(..., description="Class id from the dataset")
    # Normalised YOLO xywh: centre plus size, all 0..1.
    x: float = Field(..., ge=0.0, le=1.0)
    y: float = Field(..., ge=0.0, le=1.0)
    w: float = Field(..., ge=0.0, le=1.0)
    h: float = Field(..., ge=0.0, le=1.0)


class LabelRequest(BaseModel):
    dataset: str
    name: str
    label: str | None = Field(None, description="Class id, for classify datasets")
    boxes: list[Box] | None = Field(None, description="Boxes, for detect datasets")


def _guard(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except LabelingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logging.exception("Unexpected labelling failure")
        raise HTTPException(status_code=500, detail=f"Labelling error: {exc}") from exc


@router.get("/datasets")
def datasets():
    """Every dataset with its progress, for the picker."""
    return {"datasets": _guard(labeling.list_datasets)}


@router.get("/queue")
def queue(dataset: str, limit: int = Query(40, ge=1, le=200), include_done: bool = False):
    """The next images awaiting a decision."""
    return _guard(labeling.queue, dataset, limit, include_done)


@router.get("/stats")
def stats(dataset: str):
    """Per-class counts, so imbalance is visible while labelling."""
    return _guard(labeling.stats, dataset)


@router.get("/image")
def image(dataset: str, name: str):
    """One source image. `name` is validated against the dataset root before
    anything is opened -- it arrives from the client and is untrusted."""
    path = _guard(labeling.image_path, dataset, name)
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.post("/label")
def label(request: LabelRequest):
    boxes = [b.model_dump() for b in request.boxes] if request.boxes is not None else None
    return _guard(labeling.set_label, request.dataset, request.name, request.label, boxes)


@router.post("/undo")
def undo(dataset: str):
    return _guard(labeling.undo, dataset)


@router.post("/export")
def export(dataset: str):
    """Copy the labelled set into a training layout. Non-destructive."""
    return _guard(labeling.export, dataset)
