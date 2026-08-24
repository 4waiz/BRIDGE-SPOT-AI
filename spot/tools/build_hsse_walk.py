"""Build an HSSE inspection mission from a recorded Autowalk map.

The BRIDGE recording is a bare drive: 94 waypoints, a dock at each end and no
actions. Turning it into an HSSE inspection means deciding where to stop and
where to point, and both answers are already in the map.

The fiducials are the answer to "where". They were placed at the things worth
inspecting, and the recording saw thirteen of them. Their poses are stored in
the waypoint snapshots, so the camera aim is not guessed either: the bearing
from the robot to the tag gives pan and tilt directly.

    python spot/tools/build_hsse_walk.py --source BRIDGE --name HSSE_BRIDGE
"""
from __future__ import annotations

import argparse
import math
import shutil
import sys
from pathlib import Path

SPOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SPOT / "app"))

from bosdyn.api.autowalk import walks_pb2  # noqa: E402
from bosdyn.api.graph_nav import map_pb2  # noqa: E402
from bosdyn.client.frame_helpers import BODY_FRAME_NAME, get_a_tform_b  # noqa: E402

import action_library  # noqa: E402
import missions  # noqa: E402

# Spot CAM PTZ limits, from the action template. Pan is measured clockwise from
# the front of the robot; tilt is positive upward.
PAN_RANGE = (0.0, 360.0)
TILT_RANGE = (-30.0, 90.0)

# Confirmed on site by the operator. The rest of the tags are waypoints on
# planters and walls with nothing to inspect, so their frames are captured but
# a miss there says nothing about the detector.
EXTINGUISHER_TAGS = {13, 23, 25, 537}


def _fiducial_observations(walk_dir: Path, graph: map_pb2.Graph) -> dict[int, list[dict]]:
    """Every fiducial sighting in the map, with its pose in the robot's frame."""
    seen: dict[int, list[dict]] = {}

    for waypoint in graph.waypoints:
        snapshot_path = walk_dir / "waypoint_snapshots" / waypoint.snapshot_id
        if not snapshot_path.is_file():
            continue
        snapshot = map_pb2.WaypointSnapshot()
        snapshot.ParseFromString(snapshot_path.read_bytes())

        for obj in snapshot.objects:
            if not obj.HasField("apriltag_properties"):
                continue
            tag = obj.apriltag_properties.tag_id
            pose = _tag_in_body(obj)
            if pose is None:
                continue
            seen.setdefault(tag, []).append({
                "waypoint": waypoint.id,
                "name": waypoint.annotations.name,
                "range": math.sqrt(pose[0] ** 2 + pose[1] ** 2),
                "pose": pose,
            })
    return seen


def _tag_in_body(obj) -> tuple[float, float, float] | None:
    """Fiducial position in the robot's body frame, metres.

    Composed through the SDK rather than by hand. Adding the translations up
    the frame tree and ignoring the rotations puts every tag less than a metre
    away pointing at the ceiling, because each hop is expressed in its own
    parent's orientation.
    """
    snapshot = obj.transforms_snapshot
    props = obj.apriltag_properties
    # The filtered frame is the tracker's smoothed estimate; the raw detection
    # is the fallback when a tag was seen too briefly to be filtered.
    for frame in (props.frame_name_fiducial_filtered, props.frame_name_fiducial):
        if not frame:
            continue
        try:
            body_tform_tag = get_a_tform_b(snapshot, BODY_FRAME_NAME, frame)
        except Exception:
            body_tform_tag = None
        if body_tform_tag is not None:
            p = body_tform_tag.position
            return (p.x, p.y, p.z)
    return None


# The fiducials are mounted low, at about knee height, and the equipment they
# mark hangs above them: extinguishers roughly here, first aid boxes and hose
# reels higher again. Aiming at the tag itself frames the tag and the floor,
# which is of no use to a detector looking for a red cylinder. The camera is
# pointed at a spot above the tag instead.
EQUIPMENT_RISE_M = 0.85


def _aim(pose: tuple[float, float, float]) -> tuple[float, float]:
    """Pan and tilt, in degrees, that frame the equipment above a fiducial."""
    x, y, z = pose
    # Body frame is x forward, y left. The PTZ measures pan clockwise from the
    # front, so the sign on y is flipped.
    pan = math.degrees(math.atan2(-y, x)) % 360.0
    flat = math.sqrt(x * x + y * y)
    # The PTZ sits about 0.5 m above the body origin, so a tag at body height
    # is slightly below the camera rather than level with it.
    tilt = math.degrees(math.atan2((z + EQUIPMENT_RISE_M) - 0.5, flat)) if flat > 1e-6 else 0.0
    return (
        min(max(pan, PAN_RANGE[0]), PAN_RANGE[1]),
        min(max(tilt, TILT_RANGE[0]), TILT_RANGE[1]),
    )


def _raw_tilt(pose: tuple[float, float, float]) -> float:
    """Tilt before clamping, so a sighting the PTZ cannot reach is visible."""
    x, y, z = pose
    flat = math.sqrt(x * x + y * y)
    return (math.degrees(math.atan2((z + EQUIPMENT_RISE_M) - 0.5, flat))
            if flat > 1e-6 else 0.0)


def _clamps(pose: tuple[float, float, float]) -> bool:
    return not (TILT_RANGE[0] <= _raw_tilt(pose) <= TILT_RANGE[1])


# Close enough to read a label, far enough that the camera is not craning down
# at the wall. Chosen against the recorded sightings, most of which fall in it.
IDEAL_RANGE_M = 2.0


def _framing_cost(observation: dict) -> float:
    """Rank sightings by how well the PTZ can actually frame the tag.

    The nearest waypoint is not the best one. Standing a metre from a tag near
    floor level asks the camera for a steeper tilt than it has, and the shot
    comes out aimed at the skirting board. Backing off a little puts the tag
    inside the PTZ range and gives the detector a wider view of what is around
    it, which is what the HSSE models need anyway.
    """
    reach = 1000.0 if _clamps(observation["pose"]) else 0.0
    return reach + abs(observation["range"] - IDEAL_RANGE_M)


def _zoom_for(distance_m: float) -> float:
    """Enough zoom to fill the frame without hunting for focus.

    Roughly one power of zoom per two metres, capped well short of the 30x the
    hardware offers: past about 8x the image softens and any body sway shows.
    """
    return min(8.0, max(1.0, round(distance_m / 2.0, 1)))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="BRIDGE", help="mission id to build from")
    ap.add_argument("--name", default="HSSE_BRIDGE", help="mission id to create")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    src = missions.MISSION_DIR / f"{args.source}.walk"
    if not src.is_dir():
        print(f"No such mission: {src}")
        return 1

    graph = map_pb2.Graph()
    graph.ParseFromString((src / "graph").read_bytes())
    observations = _fiducial_observations(src, graph)
    if not observations:
        print("No fiducials in this map, nothing to inspect.")
        return 1

    # Mission ids carry the .walk suffix everywhere else in the app, and the
    # action sidecar is keyed by that id. Writing actions under the bare name
    # leaves them invisible to the upload that is meant to compose them in.
    mission_id = f"{args.name}.walk"
    dst = missions.MISSION_DIR / mission_id
    if not args.dry_run:
        if dst.exists():
            shutil.rmtree(dst)
        # The inspection mission is the same map with actions added, so the
        # graph and its snapshots are copied rather than re-recorded.
        shutil.copytree(src, dst)

        # The recorded walk is kept, renamed and retitled. It carries the route
        # and the docking that the tablet recorded; the inspection actions are
        # composed onto it at upload time rather than baked in here, so the
        # export on disk stays the one the robot produced.
        for existing in sorted((dst / "missions").iterdir()):
            if existing.suffix != ".walk":
                continue
            walk = walks_pb2.Walk()
            walk.ParseFromString(existing.read_bytes())
            walk.mission_name = args.name
            existing.unlink()
            (dst / "missions" / f"{args.name}.walk").write_bytes(walk.SerializeToString())
            break

    print(f"{args.source} -> {args.name}")
    print(f"  waypoints {len(graph.waypoints)}, fiducials {len(observations)}")
    print()

    made = 0
    clamped = 0
    for tag in sorted(observations):
        best = min(observations[tag], key=_framing_cost)
        pan, tilt = _aim(best["pose"])
        zoom = _zoom_for(best["range"])
        if _clamps(best["pose"]):
            clamped += 1

        mark = "EXT" if tag in EXTINGUISHER_TAGS else "   "
        print(f"  tag {tag:4} {mark}  at {best['name']:12}  "
              f"{best['range']:5.1f} m  pan {pan:6.1f}  tilt {tilt:5.1f}  zoom {zoom:.1f}x")

        if not args.dry_run:
            action_library.add_action(
                mission_id, best["waypoint"], "ptz_capture",
                name=("HSSE extinguisher " if tag in EXTINGUISHER_TAGS else "HSSE fiducial ") + str(tag),
                params={"pan": pan, "tilt": tilt, "zoom": zoom},
            )
        made += 1

    print()
    print(f"{made} inspection stops written to {dst.name}")
    if clamped:
        print(f"{clamped} of them still need a tilt the PTZ cannot reach; "
              f"the map has no better sighting of those tags.")
    if args.dry_run:
        print("(dry run, nothing saved)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
