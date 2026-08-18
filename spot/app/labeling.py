"""Labelling store for the HSSE emergency-detection datasets.

Three sets of Spot CAM captures sit under `spot/spot data 2025/`, in three
different states: the emergency-exit images are already sorted into class
folders, while the server-room-door and fire-safety images are unsorted.

Design decisions worth knowing:

*Nothing is moved or deleted.* Labels live in a sidecar JSON file per dataset,
not in the directory layout. Sorting 623 images by moving files is destructive,
hard to undo, and loses the original grouping the moment someone mislabels one.
A sidecar means every decision is reversible and the source images stay exactly
as captured. `export()` materialises a training layout by copying, on demand.

*Existing folder labels are imported, not ignored.* The emergency-exit set was
already sorted by hand, so that work is read in as the starting labels rather
than being thrown away.

*Two modes.* `classify` assigns one class per image. `detect` stores bounding
boxes for YOLO. Which one a dataset uses is a property of what the model needs,
not something the operator picks.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import threading
import time
from pathlib import Path

# spot/app -> spot
SPOT_ROOT = Path(__file__).resolve().parent.parent
DATA_ROOT = SPOT_ROOT / "spot data 2025"
LABEL_DIR = SPOT_ROOT / "data" / "labels"
EXPORT_DIR = SPOT_ROOT / "data" / "datasets"

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png"}

# Dataset definitions. `classes` are what the model must learn; the order is
# the keyboard order in the UI, so it is deliberate rather than alphabetical.
DATASETS = {
    "emergency_exit": {
        "id": "emergency_exit",
        "title": "Emergency exit",
        "folder": "emergency exit",
        "mode": "classify",
        "model": "emergency_exit.h5",
        "question": "Is the path to the emergency exit blocked?",
        "classes": [
            {"id": "blocked", "label": "Blocked", "hint": "Anything obstructing the exit route"},
            {"id": "unblocked", "label": "Clear", "hint": "Route is passable"},
        ],
    },
    "server_room_door": {
        "id": "server_room_door",
        "title": "Server room door",
        "folder": "server room door",
        "mode": "classify",
        "model": "server_room_door.h5",
        "question": "Is the server room door closed?",
        "classes": [
            {"id": "closed", "label": "Closed", "hint": "Door fully shut"},
            {"id": "open", "label": "Open", "hint": "Ajar or fully open"},
        ],
    },
    "fire_safety": {
        "id": "fire_safety",
        "title": "Fire safety equipment",
        "folder": "fire ext and first aid",
        "mode": "detect",
        "model": "fireextinguisherv4.pt",
        "question": "Draw a box around each fire extinguisher and first aid kit.",
        "classes": [
            {"id": "fire_extinguisher", "label": "Fire Extinguisher", "hint": "One box per unit"},
            {"id": "first_aid", "label": "First Aid", "hint": "Kits and stations"},
        ],
    },
}

_lock = threading.RLock()
_cache: dict[str, dict] = {}


class LabelingError(RuntimeError):
    """Raised for expected, reportable labelling failures."""


def _dataset(dataset_id: str) -> dict:
    spec = DATASETS.get(dataset_id)
    if spec is None:
        raise LabelingError(f"Unknown dataset '{dataset_id}'.")
    return spec


def _source_dir(spec: dict) -> Path:
    return DATA_ROOT / spec["folder"]


def _label_file(dataset_id: str) -> Path:
    return LABEL_DIR / f"{dataset_id}.json"


# -- image discovery ---------------------------------------------------------


def _scan_images(spec: dict) -> list[dict]:
    """Every image in the dataset, with any class implied by its folder.

    Images may sit directly in the dataset folder or one level down in a class
    folder; the latter is how the emergency-exit set was already sorted.
    """
    root = _source_dir(spec)
    if not root.exists():
        return []

    known = {c["id"] for c in spec["classes"]}
    found: list[dict] = []

    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in IMAGE_SUFFIXES:
            continue
        relative = path.relative_to(root)
        # Folder name becomes the imported label when it matches a class.
        implied = relative.parts[0] if len(relative.parts) > 1 else None
        found.append({
            "name": relative.as_posix(),
            "implied": implied if implied in known else None,
        })
    return found


def _load_labels(dataset_id: str) -> dict:
    """Sidecar labels, seeded from the folder layout on first use."""
    with _lock:
        if dataset_id in _cache:
            return _cache[dataset_id]

        spec = _dataset(dataset_id)
        store = {"dataset": dataset_id, "mode": spec["mode"], "items": {}, "history": []}

        path = _label_file(dataset_id)
        if path.exists():
            try:
                store = json.loads(path.read_text(encoding="utf-8"))
                store.setdefault("items", {})
                store.setdefault("history", [])
            except (OSError, ValueError) as exc:
                logging.warning("Could not read %s, starting fresh: %s", path, exc)

        # Import folder-derived labels for anything not decided yet, so hand
        # sorting already done is not repeated.
        if spec["mode"] == "classify":
            for image in _scan_images(spec):
                if image["implied"] and image["name"] not in store["items"]:
                    store["items"][image["name"]] = {
                        "label": image["implied"],
                        "source": "imported",
                        "at": None,
                    }

        _cache[dataset_id] = store
        return store


def _save_labels(dataset_id: str) -> None:
    """Write the sidecar atomically: a half-written file loses the whole set."""
    with _lock:
        store = _cache.get(dataset_id)
        if store is None:
            return
        LABEL_DIR.mkdir(parents=True, exist_ok=True)
        path = _label_file(dataset_id)
        temp = path.with_suffix(".json.tmp")
        temp.write_text(json.dumps(store, indent=2), encoding="utf-8")
        os.replace(temp, path)


# -- public API --------------------------------------------------------------


def list_datasets() -> list[dict]:
    out = []
    for spec in DATASETS.values():
        images = _scan_images(spec)
        store = _load_labels(spec["id"])
        labelled = sum(1 for i in images
                       if (store["items"].get(i["name"]) or {}).get("source", "") not in ("", "proposed"))
        out.append({
            "id": spec["id"],
            "title": spec["title"],
            "mode": spec["mode"],
            "model": spec["model"],
            "question": spec["question"],
            "classes": spec["classes"],
            "total": len(images),
            "labelled": labelled,
            "remaining": len(images) - labelled,
            "available": bool(images),
        })
    return out


def queue(dataset_id: str, limit: int = 40, include_done: bool = False) -> dict:
    """The next images needing a decision, oldest first."""
    spec = _dataset(dataset_id)
    store = _load_labels(dataset_id)
    images = _scan_images(spec)

    def reviewed(name):
        entry = store["items"].get(name)
        # A model proposal is not a decision. It seeds the boxes so the
        # operator confirms or corrects rather than drawing from scratch, but
        # the image still needs a human before it counts as labelled.
        return entry is not None and entry.get("source") != "proposed"

    pending = [
        {
            "name": i["name"],
            "label": store["items"].get(i["name"], {}).get("label"),
            "boxes": store["items"].get(i["name"], {}).get("boxes", []),
            "proposed": (store["items"].get(i["name"], {}) or {}).get("source") == "proposed",
        }
        for i in images
        if include_done or not reviewed(i["name"])
    ]
    return {
        "dataset": dataset_id,
        "mode": spec["mode"],
        "items": pending[:limit],
        "remaining": len(pending),
        "total": len(images),
        "labelled": sum(1 for i in images if reviewed(i["name"])),
    }


def _validate_name(spec: dict, name: str) -> Path:
    """Resolve an image name to a path inside the dataset, or refuse.

    The name arrives from the client, so it is untrusted: this is what stops
    `../../config.env` being served as an image.
    """
    root = _source_dir(spec).resolve()
    candidate = (root / name).resolve()
    if not candidate.is_relative_to(root):
        raise LabelingError("Invalid image name.")
    if candidate.suffix.lower() not in IMAGE_SUFFIXES:
        raise LabelingError("Not an image.")
    if not candidate.is_file():
        raise LabelingError("Image not found.")
    return candidate


def image_path(dataset_id: str, name: str) -> Path:
    return _validate_name(_dataset(dataset_id), name)


def set_label(dataset_id: str, name: str, label=None, boxes=None) -> dict:
    """Record a decision. `label` for classify, `boxes` for detect."""
    spec = _dataset(dataset_id)
    _validate_name(spec, name)
    known = {c["id"] for c in spec["classes"]}

    with _lock:
        store = _load_labels(dataset_id)

        if spec["mode"] == "classify":
            if label not in known:
                raise LabelingError(f"'{label}' is not a class of {spec['title']}.")
            entry = {"label": label, "source": "manual", "at": time.time()}
        else:
            cleaned = []
            for box in (boxes or []):
                if box.get("cls") not in known:
                    raise LabelingError(f"'{box.get('cls')}' is not a class of {spec['title']}.")
                # Normalised 0..1 xywh (YOLO convention), clamped so a box
                # dragged past the edge cannot become invalid training data.
                cleaned.append({
                    "cls": box["cls"],
                    "x": min(max(float(box["x"]), 0.0), 1.0),
                    "y": min(max(float(box["y"]), 0.0), 1.0),
                    "w": min(max(float(box["w"]), 0.0), 1.0),
                    "h": min(max(float(box["h"]), 0.0), 1.0),
                })
            # An empty list is a real answer: "no equipment in this frame" is a
            # negative example, which detection training needs.
            entry = {"boxes": cleaned, "source": "manual", "at": time.time()}

        previous = store["items"].get(name)
        store["items"][name] = entry
        store["history"].append({"name": name, "previous": previous})
        store["history"] = store["history"][-200:]
        _save_labels(dataset_id)

    return {"name": name, "saved": True}


def undo(dataset_id: str) -> dict:
    """Step back one decision."""
    with _lock:
        store = _load_labels(dataset_id)
        if not store["history"]:
            raise LabelingError("Nothing to undo.")
        last = store["history"].pop()
        if last["previous"] is None:
            store["items"].pop(last["name"], None)
        else:
            store["items"][last["name"]] = last["previous"]
        _save_labels(dataset_id)
        return {"name": last["name"], "restored": last["previous"]}


def stats(dataset_id: str) -> dict:
    """Per-class counts, so class imbalance is visible while labelling."""
    spec = _dataset(dataset_id)
    store = _load_labels(dataset_id)
    counts = {c["id"]: 0 for c in spec["classes"]}
    boxes_total = 0
    empty_frames = 0

    proposed = 0
    for entry in store["items"].values():
        if entry.get("source") == "proposed":
            proposed += 1
            continue
        if spec["mode"] == "classify":
            if entry.get("label") in counts:
                counts[entry["label"]] += 1
        else:
            found = entry.get("boxes", [])
            if not found:
                empty_frames += 1
            for box in found:
                if box["cls"] in counts:
                    counts[box["cls"]] += 1
                    boxes_total += 1

    result = {"counts": counts,
              "labelled": sum(1 for e in store["items"].values() if e.get("source") != "proposed"),
              "proposed": proposed}
    if spec["mode"] == "detect":
        result["boxes"] = boxes_total
        result["empty_frames"] = empty_frames
    return result


def export(dataset_id: str) -> dict:
    """Materialise a training layout from the sidecar.

    Classification exports a class-per-folder tree; detection exports YOLO
    label files beside an images folder plus a data.yaml. Copies rather than
    moves, so the source set stays intact and export can be re-run.
    """
    spec = _dataset(dataset_id)
    store = _load_labels(dataset_id)
    if not store["items"]:
        raise LabelingError("Nothing labelled yet.")

    out = EXPORT_DIR / dataset_id
    if out.exists():
        shutil.rmtree(out)

    written = 0
    if spec["mode"] == "classify":
        for name, entry in store["items"].items():
            if entry.get("source") == "proposed":
                continue
            label = entry.get("label")
            if not label:
                continue
            source = _source_dir(spec) / name
            if not source.is_file():
                continue
            target_dir = out / label
            target_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target_dir / Path(name).name)
            written += 1
    else:
        images_dir = out / "images"
        labels_dir = out / "labels"
        images_dir.mkdir(parents=True, exist_ok=True)
        labels_dir.mkdir(parents=True, exist_ok=True)
        order = [c["id"] for c in spec["classes"]]

        for name, entry in store["items"].items():
            # Unreviewed model proposals are not training data; exporting them
            # would train the next model on this one's mistakes.
            if entry.get("source") == "proposed":
                continue
            source = _source_dir(spec) / name
            if not source.is_file():
                continue
            stem = Path(name).stem
            shutil.copy2(source, images_dir / Path(name).name)
            lines = [
                f"{order.index(b['cls'])} {b['x']:.6f} {b['y']:.6f} {b['w']:.6f} {b['h']:.6f}"
                for b in entry.get("boxes", [])
            ]
            # An empty .txt is how YOLO represents a negative example.
            (labels_dir / f"{stem}.txt").write_text("\n".join(lines), encoding="utf-8")
            written += 1

        (out / "data.yaml").write_text(
            "path: " + out.as_posix() + "\ntrain: images\nval: images\n"
            "names:\n" + "".join(f"  {i}: {c}\n" for i, c in enumerate(order)),
            encoding="utf-8",
        )

    return {"exported": written, "path": str(out), "mode": spec["mode"]}


def seed_proposals(dataset_id: str, proposals: dict) -> dict:
    """Pre-populate boxes from a model, for the operator to confirm or correct.

    Stored with source="proposed" so they are excluded from progress counts and
    from export. They only become labels once a human saves them.
    Never overwrites an existing human decision.
    """
    spec = _dataset(dataset_id)
    known = {c["id"] for c in spec["classes"]}

    with _lock:
        store = _load_labels(dataset_id)
        seeded = skipped = 0
        for name, boxes in proposals.items():
            existing = store["items"].get(name)
            if existing is not None and existing.get("source") != "proposed":
                skipped += 1
                continue
            cleaned = [
                {
                    "cls": b["cls"],
                    "x": min(max(float(b["x"]), 0.0), 1.0),
                    "y": min(max(float(b["y"]), 0.0), 1.0),
                    "w": min(max(float(b["w"]), 0.0), 1.0),
                    "h": min(max(float(b["h"]), 0.0), 1.0),
                    "conf": round(float(b.get("conf", 0)), 3),
                }
                for b in boxes if b.get("cls") in known
            ]
            store["items"][name] = {"boxes": cleaned, "source": "proposed", "at": time.time()}
            seeded += 1
        _save_labels(dataset_id)

    logging.info("Seeded %d proposals for %s (%d already reviewed)", seeded, dataset_id, skipped)
    return {"seeded": seeded, "skipped_reviewed": skipped}
