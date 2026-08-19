"""Build a mission whose only job is to bring Spot home and dock it.

The dock command on its own only works within sight of the dock fiducial, so it
is no help when a mission has stopped partway round a route. Driving back by
hand is worse: velocity commands with nobody watching the path is how a robot
walks into something.

This makes a one-element walk that navigates to the docked waypoint and docks.
It uses navigate_to rather than navigate_route, so GraphNav plans the way home
from wherever the robot is standing instead of replaying a recorded path from
the beginning. There are no inspection actions in it, so there is nothing that
can fail the way the HSSE run did.

    python spot/tools/build_dock_walk.py --source HSSE_BRIDGE --name GO_HOME
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

SPOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SPOT / "app"))

from bosdyn.api.autowalk import walks_pb2  # noqa: E402
from bosdyn.api.graph_nav import map_pb2  # noqa: E402

import missions  # noqa: E402


def _neighbour_of(graph_path: Path, waypoint_id: str) -> str | None:
    """A waypoint one edge away from the given one, if the map has one."""
    graph = map_pb2.Graph()
    graph.ParseFromString(graph_path.read_bytes())
    for edge in graph.edges:
        if edge.id.to_waypoint == waypoint_id:
            return edge.id.from_waypoint
        if edge.id.from_waypoint == waypoint_id:
            return edge.id.to_waypoint
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="HSSE_BRIDGE", help="mission whose map to reuse")
    ap.add_argument("--name", default="GO_HOME")
    args = ap.parse_args()

    src = missions.MISSION_DIR / f"{args.source}.walk"
    if not src.is_dir():
        print(f"No such mission: {src}")
        return 1

    info = missions.describe(src)
    dock_waypoint = info.get("docked_waypoint")
    dock_ids = info.get("dock_ids") or []
    if not dock_waypoint or not dock_ids:
        print(f"{args.source} has no dock recorded, so there is nowhere to send it.")
        return 1

    mission_id = f"{args.name}.walk"
    dst = missions.MISSION_DIR / mission_id
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)

    for stale in (dst / "missions").iterdir():
        stale.unlink()

    walk = walks_pb2.Walk()
    walk.mission_name = args.name
    walk.map_name = info.get("map_name", args.source)
    walk.global_parameters.self_right_attempts = 1

    # Navigate to the waypoint NEXT to the dock, not the dock waypoint itself.
    # The docked waypoint sits physically on the dock, so asking GraphNav to
    # stand there reports the goal region as blocked: the dock is an obstacle.
    # The recorded route reflects this, starting at the neighbour rather than
    # the dock. The final approach belongs to the docking service.
    approach = _neighbour_of(dst / "graph", dock_waypoint) or dock_waypoint
    if approach == dock_waypoint:
        print("warning: no waypoint adjacent to the dock; navigating onto it directly")

    element = walk.elements.add()
    element.name = "Return to dock"
    element.target.navigate_to.destination_waypoint_id = approach
    # No action on this element: the point of this mission is that there is
    # nothing in it that can fail except the walking itself.
    element.target_failure_behavior.retry_count = 3
    element.target_failure_behavior.prompt_duration.seconds = 30
    element.target_failure_behavior.safe_power_off.SetInParent()

    dock = walk.docks.add()
    dock.dock_id = int(dock_ids[0])
    dock.docked_waypoint_id = dock_waypoint

    (dst / "missions" / f"{args.name}.walk").write_bytes(walk.SerializeToString())

    print(f"{args.name}: navigate to {approach[:32]} then dock {dock_ids[0]}")
    print(f"written to {dst.name}")
    print()
    print("Upload and play it the same way as any other mission.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
