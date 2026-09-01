"""Build a mission that stands the robot square in front of a fiducial.

Navigating to the waypoint alone gets the robot to the right place with an
arbitrary heading, so the equipment ends up off to one side and photographed at
a slant. The frames from tag 23 came out oblique for exactly that reason, and
the extinguishers had to be found by sweeping the camera.

NavigateTo takes a body goal expressed relative to the destination waypoint, so
the pose can be asked for directly: stand a set distance out along the tag's own
normal, facing back at it. A fiducial's frame has z pointing out of its face,
which is what gives the standoff direction. From there the equipment is dead
ahead and the PTZ only has to tilt up to the gear above the tag.

    python spot/tools/build_faceon_walk.py --tag 23 --name FACE_23
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
from bosdyn.client.math_helpers import SE3Pose  # noqa: E402

import missions  # noqa: E402

from build_dock_walk import _neighbour_of  # noqa: E402

# Far enough back that a 6 kg extinguisher and the box above it both fit in
# frame, close enough to read a label.
STANDOFF_M = 1.8


def tag_in_waypoint(walk_dir: Path, waypoint, tag_id: int) -> SE3Pose | None:
    """Pose of a fiducial in its waypoint's own frame."""
    snapshot_path = walk_dir / "waypoint_snapshots" / waypoint.snapshot_id
    if not snapshot_path.is_file():
        return None
    snapshot = map_pb2.WaypointSnapshot()
    snapshot.ParseFromString(snapshot_path.read_bytes())

    for obj in snapshot.objects:
        props = obj.apriltag_properties
        if not obj.HasField("apriltag_properties") or props.tag_id != tag_id:
            continue
        for frame in (props.frame_name_fiducial_filtered, props.frame_name_fiducial):
            if not frame:
                continue
            try:
                # A waypoint is laid down at the robot's body pose, so the
                # body frame of the recording is the waypoint frame the body
                # goal is expressed in.
                pose = get_a_tform_b(obj.transforms_snapshot, BODY_FRAME_NAME, frame)
            except Exception:
                pose = None
            if pose is not None:
                return pose
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", type=int, required=True)
    ap.add_argument("--name", default=None)
    ap.add_argument("--source", default="BRIDGE")
    ap.add_argument("--standoff", type=float, default=STANDOFF_M)
    ap.add_argument("--speed", type=float, default=0.4)
    args = ap.parse_args()

    name = args.name or f"FACE_{args.tag}"
    src = missions.MISSION_DIR / f"{args.source}.walk"
    graph = map_pb2.Graph()
    graph.ParseFromString((src / "graph").read_bytes())

    # Pick the waypoint that saw the tag most squarely, not the nearest: a
    # sighting from an angle gives a worse estimate of where the wall faces.
    best = None
    for waypoint in graph.waypoints:
        pose = tag_in_waypoint(src, waypoint, args.tag)
        if pose is None:
            continue
        span = math.hypot(pose.x, pose.y)
        if best is None or span < best[1]:
            best = (waypoint, span, pose)

    if best is None:
        print(f"Fiducial {args.tag} is not in this map.")
        return 1

    waypoint, span, tag = best
    names = {w.id: w.annotations.name for w in graph.waypoints}
    print(f"tag {args.tag} seen from {names.get(waypoint.id, '?')} at {span:.2f} m")

    # A fiducial's z axis points out of its face, so the third column of its
    # rotation is the direction to stand in.
    rot = tag.rotation.to_matrix()
    out_x, out_y = float(rot[0][2]), float(rot[1][2])
    norm = math.hypot(out_x, out_y)
    if norm < 1e-6:
        print("This tag faces straight up or down; cannot stand in front of it.")
        return 1
    out_x, out_y = out_x / norm, out_y / norm

    goal_x = tag.x + out_x * args.standoff
    goal_y = tag.y + out_y * args.standoff
    # Face back towards the tag.
    heading = math.atan2(-out_y, -out_x)

    print(f"standing at ({goal_x:+.2f}, {goal_y:+.2f}) in waypoint frame, "
          f"facing {math.degrees(heading):+.0f} deg")

    mission_id = f"{name}.walk"
    dst = missions.MISSION_DIR / mission_id
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    for stale in (dst / "missions").iterdir():
        stale.unlink()

    walk = walks_pb2.Walk()
    walk.mission_name = name
    walk.map_name = args.source
    walk.global_parameters.self_right_attempts = 1

    element = walk.elements.add()
    element.name = f"Face tag {args.tag}"
    nav = element.target.navigate_to
    nav.destination_waypoint_id = waypoint.id
    nav.destination_waypoint_tform_body_goal.position.x = goal_x
    nav.destination_waypoint_tform_body_goal.position.y = goal_y
    nav.destination_waypoint_tform_body_goal.angle = heading

    limit = nav.travel_params.velocity_limit
    limit.max_vel.linear.x = args.speed
    limit.max_vel.linear.y = args.speed
    limit.max_vel.angular = args.speed
    limit.min_vel.linear.x = -args.speed
    limit.min_vel.linear.y = -args.speed
    limit.min_vel.angular = -args.speed

    element.target_failure_behavior.retry_count = 2
    element.target_failure_behavior.prompt_duration.seconds = 20
    element.target_failure_behavior.safe_power_off.SetInParent()

    (dst / "missions" / f"{name}.walk").write_bytes(walk.SerializeToString())
    print(f"written to {dst.name}")
    print("Outward leg only; run GO_HOME afterwards.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
