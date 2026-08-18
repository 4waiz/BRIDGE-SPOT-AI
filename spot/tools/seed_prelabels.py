"""Seed the fire-safety dataset with model-proposed boxes for review.

Drawing ~1500 boxes by hand is the slow part of retraining. Running the current
model at a low threshold turns that into confirm-or-correct, which is far
faster and is standard pre-annotation practice.

The proposals are stored as source="proposed", which deliberately does NOT
count as labelled and is excluded from export. They are a starting point for a
human, not training data: exporting them unreviewed would train the next model
on this one's mistakes, and this model is known to be wrong.

    python spot/tools/seed_prelabels.py [--conf 0.15]
"""
from __future__ import annotations

import argparse
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "app"))

import labeling  # noqa: E402
from ultralytics import YOLO  # noqa: E402

DATASET = "fire_safety"
# Class ids in the labelling registry differ from the model's display names.
NAME_TO_CLASS = {"Fire Extinguisher": "fire_extinguisher", "First Aid": "first_aid"}


def main() -> int:
    ap = argparse.ArgumentParser()
    # Low on purpose: a false box the operator deletes costs a keystroke, a
    # missed one costs drawing it from scratch.
    ap.add_argument("--conf", type=float, default=0.15)
    args = ap.parse_args()

    spec = labeling.DATASETS[DATASET]
    root = labeling.DATA_ROOT / spec["folder"]
    images = sorted(p for p in root.iterdir()
                    if p.suffix.lower() in labeling.IMAGE_SUFFIXES)
    if not images:
        print("no images found in", root)
        return 1

    model = YOLO(str(ROOT / "data" / "models" / spec["model"]))
    proposals: dict[str, list[dict]] = {}
    total = 0

    for path in images:
        result = model.predict(str(path), conf=args.conf, verbose=False)[0]
        height, width = result.orig_shape
        boxes = []
        for b in result.boxes:
            name = model.names[int(b.cls[0])]
            cls = NAME_TO_CLASS.get(name)
            if cls is None:
                continue
            x1, y1, x2, y2 = [float(v) for v in b.xyxy[0].tolist()]
            # Model gives corner pixels; the store wants normalised centre+size.
            boxes.append({
                "cls": cls,
                "x": ((x1 + x2) / 2) / width,
                "y": ((y1 + y2) / 2) / height,
                "w": (x2 - x1) / width,
                "h": (y2 - y1) / height,
                "conf": float(b.conf.item()),
            })
        proposals[path.name] = boxes
        total += len(boxes)

    result = labeling.seed_proposals(DATASET, proposals)
    print(f"images processed : {len(images)}")
    print(f"boxes proposed   : {total}")
    print(f"seeded           : {result['seeded']}")
    print(f"left alone       : {result['skipped_reviewed']} (already reviewed by a human)")
    print("\nOpen the Labelling page and work through Fire safety equipment.")
    print("Proposals are NOT counted as labelled and are excluded from export")
    print("until you save each image.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
