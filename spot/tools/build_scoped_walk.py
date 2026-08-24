"""Build a short inspection mission covering only the fiducials asked for.

The full HSSE walk replays the whole recorded route before it visits anything,
which is 400 ft and, at the moment, a function room laid out for an event. For
checking one or two pieces of equipment that is a lot of floor to cross and a
lot of chances to meet a chair.

This builds the mission from nothing instead of appending to the recording: one
element per fiducial that navigates straight to the best waypoint for it and
takes the photograph, then a last element back to the dock. navigate_to lets
GraphNav plan each leg, so it takes whatever way is passable rather than
insisting on the recorded path.

The elements are built here rather than registered in the action sidecar,
because the sidecar is composed in at upload time by appending to the end of
the walk. A mission written as "go to the tag, then go home" came back as "go
to the tag, go home, then go and photograph the tag", and the run ended at the
docking step having never taken the picture.

    python spot/tools/build_scoped_walk.py --tags 23 --name HSSE_23
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

SPOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SPOT / "app"))

from bosdyn.api import geometry_pb2  # noqa: E402
from bosdyn.api.autowalk import walks_pb2  # noqa: E402
from bosdyn.api.graph_nav import graph_nav_pb2, map_pb2  # noqa: E402

import action_library  # noqa: E402
import missions  # noqa: E402

from build_hsse_walk import (  # noqa: E402
    EXTINGUISHER_TAGS, _aim, _fiducial_observations, _framing_cost, _zoom_for,
)
from build_dock_walk import _neighbour_of  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="BRIDGE", help="mission whose map to reuse")
    ap.add_argument("--name", default="HSSE_23")
    ap.add_argument("--tags", required=True,
                    help="comma separated fiducial ids, e.g. 23 or 13,23,25")
    # Spot walks at about 1.6 m/s left alone. Half a metre a second is a slow
    # deliberate walk: easier to watch, easier to stop, and far less likely to
    # meet a chair at speed in a room being set up around it.
    ap.add_argument("--speed", type=float, default=0.5,
                    help="max linear speed in m/s")
    ap.add_argument("--turn-speed", type=float, default=0.4,
                    help="max angular speed in rad/s")
    args = ap.parse_args()

    wanted = {int(t) for t in args.tags.split(",") if t.strip()}

    src = missions.MISSION_DIR / f"{args.source}.walk"
    if not src.is_dir():
        print(f"No such mission: {src}")
        return 1

    graph = map_pb2.Graph()
    graph.ParseFromString((src / "graph").read_bytes())
    observations = _fiducial_observations(src, graph)

    missing = wanted - set(observations)
    if missing:
        print(f"These tags are not in the map: {sorted(missing)}")
        return 1

    info = missions.describe(src)
    dock_waypoint = info.get("docked_waypoint")
    dock_ids = info.get("dock_ids") or []
    if not dock_waypoint or not dock_ids:
        print("This map has no dock recorded.")
        return 1

    mission_id = f"{args.name}.walk"
    dst = missions.MISSION_DIR / mission_id
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    for stale in (dst / "missions").iterdir():
        stale.unlink()

    # Actions are keyed by mission id and composed in at upload time, so any
    # left over from a previous build of this name have to go.
    sidecar = action_library.ACTION_DIR / f"{mission_id}.json"
    if sidecar.exists():
        sidecar.unlink()

    walk = walks_pb2.Walk()
    walk.mission_name = args.name
    walk.map_name = info.get("map_name", args.source)
    walk.global_parameters.self_right_attempts = 1
    walk.global_parameters.should_autofocus_ptz = True

    def slow(navigate_to):
        """Cap the speed for one leg of the walk."""
        limit = navigate_to.travel_params.velocity_limit
        limit.max_vel.linear.x = args.speed
        limit.max_vel.linear.y = args.speed
        limit.max_vel.angular = args.turn_speed
        # A minimum has to be given alongside the maximum or the limit is
        # read as one-sided and the robot can still reverse at full tilt.
        limit.min_vel.linear.x = -args.speed
        limit.min_vel.linear.y = -args.speed
        limit.min_vel.angular = -args.turn_speed

    names = {w.id: w.annotations.name for w in graph.waypoints}
    print(f"{args.name}: {len(wanted)} stop(s) then home to dock {dock_ids[0]}")
    print(f"  speed capped to {args.speed} m/s linear, {args.turn_speed} rad/s turning")
    print()

    for tag in sorted(wanted):
        best = min(observations[tag], key=_framing_cost)
        pan, tilt = _aim(best["pose"])
        zoom = _zoom_for(best["range"])
        label = ("HSSE extinguisher " if tag in EXTINGUISHER_TAGS
                 else "HSSE fiducial ") + str(tag)

        element = walk.elements.add()
        element.CopyFrom(action_library._build_element({
            "id": f"tag{tag}",
            "template": "ptz_capture",
            "name": label,
            "waypoint": best["waypoint"],
            "params": {"pan": pan, "tilt": tilt, "zoom": zoom},
        }))
        slow(element.target.navigate_to)
        print(f"  tag {tag:4}  {names.get(best['waypoint'], '?'):12}  "
              f"{best['range']:.1f} m  pan {pan:6.1f}  tilt {tilt:5.1f}  zoom {zoom:.1f}x")

    # Home again. The target is the waypoint beside the dock, never the docked
    # waypoint itself: that one sits on the dock, so GraphNav reads the goal
    # region as blocked. The docking service handles the last few feet.
    approach = _neighbour_of(dst / "graph", dock_waypoint) or dock_waypoint
    home = walk.elements.add()
    home.name = "Return to dock"
    home.target.navigate_to.destination_waypoint_id = approach
    slow(home.target.navigate_to)
    home.target_failure_behavior.retry_count = 3
    home.target_failure_behavior.prompt_duration.seconds = 30
    home.target_failure_behavior.safe_power_off.SetInParent()

    dock = walk.docks.add()
    dock.dock_id = int(dock_ids[0])
    dock.docked_waypoint_id = dock_waypoint

    (dst / "missions" / f"{args.name}.walk").write_bytes(walk.SerializeToString())
    print()
    print(f"  return via {names.get(approach, '?')} then dock {dock_ids[0]}")
    print(f"written to {dst.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
