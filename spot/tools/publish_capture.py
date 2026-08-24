"""Publish a photograph the robot took to the HSSE page, with detections drawn.

Writes into the layout the page already reads (annotated_image_N.jpg plus
latest_text_N.json under data/latest/HSSE), so a new capture appears with no UI
change.

The model choice is not the deployed one by default, and that is deliberate.
On the frame this was written for, a close, well-lit, unobstructed photograph
of two extinguishers and a first aid box taken by the robot itself,
fireextinguisherv4 returns nothing at all, down to a confidence of 0.05.
fireextinguisherv3, the model it replaced, finds them. Publishing an empty
result from v4 would put "no equipment detected" on a safety dashboard next to
a picture of the equipment.

    python spot/tools/publish_capture.py --image "<path>" --slot 2 --place "Fiducial 23"
"""
from __future__ import annotations

import argparse
import json
import os
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

from PIL import Image, ImageDraw, ImageFont  # noqa: E402
from ultralytics import YOLO  # noqa: E402

SPOT = Path(__file__).resolve().parent.parent
OUT = SPOT / "data" / "latest" / "HSSE"
FONT_PATH = SPOT / "frontend" / "fonts" / "NotoSans-Regular.ttf"

REQUIRED = {"Fire Extinguisher": 2, "First Aid": 1}
# Green for both classes: the operator asked for green boxes, and on a safety
# page a colour that reads as an alert should mean an alert, not a class id.
BOX_COLOUR = (46, 160, 67)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--slot", type=int, default=2, help="which dashboard frame, 1-3")
    ap.add_argument("--place", default="", help="where this was taken")
    ap.add_argument("--model", default="fireextinguisherv3.pt")
    ap.add_argument("--conf", type=float, default=0.05)
    args = ap.parse_args()

    src = Path(args.image)
    if not src.is_file():
        print(f"No such image: {src}")
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    model = YOLO(str(SPOT / "data" / "models" / args.model))
    result = model.predict(str(src), conf=args.conf, verbose=False)[0]

    img = Image.open(src).convert("RGB")
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(str(FONT_PATH), 28)

    values, boxes, confs = [], [], []
    for box in result.boxes:
        name = model.names[int(box.cls[0])]
        conf = float(box.conf.item())
        x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]

        draw.rectangle((x1, y1, x2, y2), outline=BOX_COLOUR, width=6)
        label = f"{name}: {conf:.1%}"
        anchor = (x1, max(0.0, y1 - 34))
        tb = draw.textbbox(anchor, label, font=font)
        draw.rectangle(tb, fill=BOX_COLOUR)
        draw.text(anchor, label, fill=(255, 255, 255), font=font)

        values.append(name)
        boxes.append([[x1, y1, x2, y2]])
        confs.append(conf)

    counts = {k: values.count(k) for k in REQUIRED}
    short = [f"{REQUIRED[k] - counts[k]} {k}" for k in REQUIRED if counts[k] < REQUIRED[k]]

    where = f" at {args.place}" if args.place else ""
    if not short:
        text = f"All required equipment present{where}."
        ok = "OK"
    else:
        found = ", ".join(f"{counts[k]} {k}" for k in REQUIRED)
        text = f"Found {found}{where}. Short: {', '.join(short)}."
        ok = "NOK"

    img.save(OUT / f"annotated_image_{args.slot}.jpg", quality=92)
    (OUT / f"latest_text_{args.slot}.json").write_text(json.dumps({
        "result_values": values,
        "box_vectors": boxes,
        "confidences": confs,
        "output_text": text,
        "output_boolean": ok,
    }, indent=4), encoding="utf-8")

    print(f"model  : {args.model} at conf {args.conf}")
    print(f"found  : {values if values else 'nothing'}")
    print(f"verdict: {ok} - {text}")
    print(f"written to slot {args.slot} of the HSSE page")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
