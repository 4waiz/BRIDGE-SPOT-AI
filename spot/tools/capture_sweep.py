"""Capture a Spot CAM PTZ sweep, for fresh HSSE training images.

The fire-safety detector was trained on one capture session and reports 568
first-aid boxes across that set while finding none on new photographs of the
same building. That is overfitting to the original conditions, and more of the
same images will not fix it. New captures, through the robot's own optics at
the angles the robot actually inspects from, will.

Camera only. Pan and tilt move the Spot CAM head; the body stays put, so this
runs from the dock without a lease or the E-stop.

    python spot/tools/capture_sweep.py --tag dock --steps 12
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import requests

SPOT = Path(__file__).resolve().parent.parent
API = "http://127.0.0.1:4000/api/robot"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="sweep", help="label for this capture set")
    ap.add_argument("--steps", type=int, default=12, help="pan positions")
    ap.add_argument("--tilt", type=float, default=-10.0)
    ap.add_argument("--zoom", type=float, default=1.0)
    ap.add_argument("--settle", type=float, default=1.5,
                    help="seconds to let the head stop moving before the frame")
    args = ap.parse_args()

    out = SPOT / "spot data 2025" / f"capture {args.tag}"
    out.mkdir(parents=True, exist_ok=True)

    state = requests.get(f"{API}/state", timeout=20).json()
    if not state.get("connected"):
        print("Robot is not connected.")
        return 1
    print(f"battery {state['battery']['percentage']:.0f}%  "
          f"docked={state.get('docking', {}).get('status')}")
    print(f"writing to {out}")
    print()

    saved = 0
    for i in range(args.steps):
        pan = round((360.0 / args.steps) * i, 1)
        try:
            requests.post(f"{API}/actions/aim", timeout=30, json={
                "pan": pan, "tilt": args.tilt, "zoom": args.zoom}).raise_for_status()
        except requests.RequestException as exc:
            print(f"  pan {pan:6.1f}  aim failed: {exc}")
            continue

        # The PTZ reports the commanded angle before it has finished moving, so
        # a frame taken immediately is of wherever the head was mid-slew.
        time.sleep(args.settle)

        try:
            frame = requests.get(f"{API}/camera/cam-ptz", timeout=45)
            frame.raise_for_status()
        except requests.RequestException as exc:
            print(f"  pan {pan:6.1f}  capture failed: {exc}")
            continue

        if not frame.content or len(frame.content) < 2048:
            print(f"  pan {pan:6.1f}  empty frame, skipped")
            continue

        path = out / f"{args.tag}_pan{int(pan):03d}_tilt{int(args.tilt):+03d}.jpg"
        path.write_bytes(frame.content)
        saved += 1
        print(f"  pan {pan:6.1f}  {len(frame.content)//1024:4} KB  {path.name}")

    print()
    print(f"{saved}/{args.steps} frames captured into {out.name}")
    if saved:
        print("Label them from the Labelling page, then retrain.")
    return 0 if saved else 1


if __name__ == "__main__":
    raise SystemExit(main())
