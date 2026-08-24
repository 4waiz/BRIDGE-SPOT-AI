"""Point the Spot CAM at a fiducial the robot can see now, and photograph it.

Aiming from the recorded map assumes the robot ends up facing the way it faced
during recording. It does not: GraphNav gets it to the waypoint, not to the
heading, and a PTZ aimed on that assumption photographs a lift door while the
extinguishers sit behind the robot's shoulder.

This asks the robot where the tag is at this instant instead, through the world
object service, and derives pan and tilt from that. It also aims above the tag,
because the fiducials here are mounted low and the equipment they mark hangs
above them.

    python spot/tools/shoot_fiducial.py --tag 23 --out "capture tag23"
"""
from __future__ import annotations

import argparse
import math
import os
import sys
import time
from pathlib import Path

import requests

SPOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SPOT / "app"))

import dotenv  # noqa: E402

dotenv.load_dotenv(SPOT / "config.env")

import bosdyn.client  # noqa: E402
import bosdyn.client.spot_cam  # noqa: E402
from bosdyn.api import world_object_pb2  # noqa: E402
from bosdyn.client.frame_helpers import BODY_FRAME_NAME, get_a_tform_b  # noqa: E402
from bosdyn.client.world_object import WorldObjectClient  # noqa: E402

API = "http://127.0.0.1:4000/api/robot"
# The equipment hangs above the tag; see build_hsse_walk for the same constant.
EQUIPMENT_RISE_M = 0.85
PTZ_HEIGHT_M = 0.5


def find_tag(robot, tag_id: int):
    """Pose of one fiducial in the body frame, from what the robot sees now."""
    client = robot.ensure_client(WorldObjectClient.default_service_name)
    objects = client.list_world_objects(
        object_type=[world_object_pb2.WORLD_OBJECT_APRILTAG]).world_objects

    for obj in objects:
        props = obj.apriltag_properties
        if props.tag_id != tag_id:
            continue
        for frame in (props.frame_name_fiducial_filtered, props.frame_name_fiducial):
            if not frame:
                continue
            pose = get_a_tform_b(obj.transforms_snapshot, BODY_FRAME_NAME, frame)
            if pose is not None:
                return pose.position
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", type=int, default=23)
    ap.add_argument("--out", default="capture live")
    ap.add_argument("--settle", type=float, default=4.0)
    args = ap.parse_args()

    sdk = bosdyn.client.create_standard_sdk("BridgeShootFiducial")
    bosdyn.client.spot_cam.register_all_service_clients(sdk)
    robot = sdk.create_robot(os.getenv("SPOT_IP", "192.168.33.137"))
    robot.authenticate(os.getenv("BOSDYN_CLIENT_USERNAME", "").strip(),
                       os.getenv("BOSDYN_CLIENT_PASSWORD", "").strip())

    position = find_tag(robot, args.tag)
    if position is None:
        print(f"Fiducial {args.tag} is not in view. Visible tags:")
        client = robot.ensure_client(WorldObjectClient.default_service_name)
        for obj in client.list_world_objects(
                object_type=[world_object_pb2.WORLD_OBJECT_APRILTAG]).world_objects:
            print(f"   tag {obj.apriltag_properties.tag_id}")
        return 1

    x, y, z = position.x, position.y, position.z
    flat = math.hypot(x, y)
    # Body frame is x forward, y left; the PTZ measures pan clockwise from the
    # front, so the sign on y flips.
    pan = math.degrees(math.atan2(-y, x)) % 360.0
    tilt = math.degrees(math.atan2((z + EQUIPMENT_RISE_M) - PTZ_HEIGHT_M, flat))
    tilt = min(max(tilt, -30.0), 90.0)
    zoom = min(8.0, max(1.0, round(flat / 2.0, 1)))

    print(f"tag {args.tag} is {flat:.2f} m away, {z:+.2f} m in height")
    print(f"aiming pan {pan:.1f}  tilt {tilt:.1f}  zoom {zoom:.1f}x")

    requests.post(f"{API}/actions/aim", timeout=30,
                  json={"pan": pan, "tilt": tilt, "zoom": zoom}).raise_for_status()
    # The PTZ reports the commanded angle before it has finished moving, so a
    # frame taken straight away is of wherever the head was mid-slew.
    time.sleep(args.settle)

    out = SPOT / "spot data 2025" / args.out
    out.mkdir(parents=True, exist_ok=True)
    frame = requests.get(f"{API}/camera/cam-ptz", timeout=60)
    frame.raise_for_status()
    path = out / f"tag{args.tag}_live_pan{int(pan):03d}_tilt{int(tilt):+03d}.jpg"
    path.write_bytes(frame.content)
    print(f"saved {path.name} ({len(frame.content) // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
