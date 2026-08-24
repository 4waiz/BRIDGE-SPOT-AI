"""Autowalk mission library and playback.

Reads `.walk` exports from `spot/data/missions/`, uploads them to the robot and
drives playback. A `.walk` directory is what the tablet produces: a GraphNav
graph, a waypoint snapshot per node, edge snapshots, and an autowalk `Walk`
proto describing the route and any inspection actions attached to it.

Playing one back is a five step sequence, and the order matters:

  1. upload the graph, then any snapshots the robot does not already hold
  2. upload the walk itself
  3. localise the robot into the map, by fiducial
  4. power on and stand
  5. play, polling mission state until it finishes

Step 3 is the one that bites: without a localisation the robot has no idea
where it is on the map, and the mission will refuse to start. The tablet does
this implicitly when you start from the dock, which is why it is easy to forget.

Safety
------
This is the highest-risk feature in the dashboard. Playback walks the robot
along a recorded route autonomously -- the HSSE route is 435 feet -- and the
operator is not steering. It goes through the same E-stop and lease chain as
everything else, refuses to start without a localisation, and can be paused or
stopped at any point. It should never be started unattended.
"""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path

import action_library
from bosdyn.api.autowalk import walks_pb2
from bosdyn.api.graph_nav import graph_nav_pb2, map_pb2, nav_pb2
from bosdyn.api.mission import mission_pb2

SPOT_ROOT = Path(__file__).resolve().parent.parent
MISSION_DIR = SPOT_ROOT / "data" / "missions"

UPLOAD_TIMEOUT = 60.0
# How far ahead the robot is allowed to run before it needs another play call.
# Short enough that pausing feels immediate, long enough to survive a slow poll.
# How far ahead each tick authorises the robot to keep running.
#
# This is the robot's autonomy budget, not a polling rate. The mission itself
# executes on the robot; this loop only keeps extending permission. At 15s a
# wifi dropout longer than fifteen seconds expired that permission and the
# robot stopped mid-route, which is what ended every run so far on the stretch
# between the dock and tag 23. Ninety seconds lets it walk through a blackout
# and carry on, and the loop re-extends the moment comms return.
#
# Granting autonomy this far ahead is only reasonable because the robot has its
# own guards underneath: controller supervision cuts motor power on its own
# schedule, and AutoReturn backtracks to re-establish comms. Stopping on demand
# is unaffected while comms are up, since pause is an immediate RPC.
PLAY_LEASE_SECONDS = 90.0
POLL_INTERVAL = 1.0

# How long the robot may be unreachable before a mission is given up on.
#
# The robot rides the same wifi as everyone else and roams between access
# points as it walks, and a roam drops packets. Measured on site: at the dock
# the link is 0% loss at 3 ms, and out on the route it reached 75% loss. A
# single failed RPC is therefore an ordinary event on a long walk, not a reason
# to abandon a robot in a corridor, which is exactly what happened when one
# UnableToConnectToRobotError ended a run mid-route.
#
# It has to outlast PLAY_LEASE_SECONDS, or the loop would give up while the
# robot still had permission to run and was making progress. Measured dropouts
# on this site lasted tens of seconds, so this covers one comfortably while
# still reporting a genuinely dead link before the operator loses patience. It
# sits under the robot's own comms-loss behaviour rather than replacing it:
# supervision still cuts motor power on its own schedule.
COMMS_GRACE_SECONDS = 150.0


class MissionError(RuntimeError):
    """Raised for expected, reportable mission failures."""


# -- library -----------------------------------------------------------------


def _walk_dirs() -> list[Path]:
    if not MISSION_DIR.exists():
        return []
    return sorted(p for p in MISSION_DIR.iterdir() if p.is_dir() and (p / "graph").is_file())


def _read_graph(walk_dir: Path) -> map_pb2.Graph:
    graph = map_pb2.Graph()
    graph.ParseFromString((walk_dir / "graph").read_bytes())
    return graph


def _read_walk(walk_dir: Path) -> walks_pb2.Walk | None:
    """The autowalk definition, if this export has one."""
    mission_dir = walk_dir / "missions"
    if not mission_dir.is_dir():
        return None
    for candidate in sorted(mission_dir.iterdir()):
        if candidate.is_file():
            try:
                walk = walks_pb2.Walk()
                walk.ParseFromString(candidate.read_bytes())
                return walk
            except Exception as exc:
                logging.debug("%s is not an autowalk Walk: %s", candidate, exc)
    return None


def _route_length_m(graph: map_pb2.Graph) -> float:
    """Sum of the edge translations -- the distance actually walked."""
    total = 0.0
    for edge in graph.edges:
        t = edge.from_tform_to.position
        total += (t.x ** 2 + t.y ** 2 + t.z ** 2) ** 0.5
    return total


def describe(walk_dir: Path) -> dict:
    """Everything the UI shows about a mission, read from the export itself."""
    graph = _read_graph(walk_dir)
    walk = _read_walk(walk_dir)

    snapshot_dir = walk_dir / "waypoint_snapshots"
    have = {p.name for p in snapshot_dir.iterdir()} if snapshot_dir.is_dir() else set()
    missing = [w.snapshot_id for w in graph.waypoints if w.snapshot_id and w.snapshot_id not in have]

    dock_ids = []
    docked_waypoint = None
    if walk is not None:
        for dock in walk.docks:
            dock_ids.append(dock.dock_id)
            if dock.docked_waypoint_id:
                docked_waypoint = dock.docked_waypoint_id

    metres = _route_length_m(graph)
    return {
        "id": walk_dir.name,
        "name": (walk.mission_name if walk and walk.mission_name else walk_dir.stem),
        "map_name": walk.map_name if walk else None,
        "waypoints": len(graph.waypoints),
        "edges": len(graph.edges),
        "route_m": round(metres, 1),
        "route_ft": round(metres * 3.28084, 1),
        # An autowalk with no elements navigates and docks but captures nothing.
        # Surfacing it stops someone expecting inspection images that will
        # never arrive.
        "actions": len(walk.elements) if walk else 0,
        "has_walk_file": walk is not None,
        "dock_ids": dock_ids,
        "docked_waypoint": docked_waypoint,
        "missing_snapshots": len(missing),
        "playable": walk is not None and not missing,
        "has_point_cloud": (walk_dir / "point_cloud.ply").is_file(),
        "waypoint_names": [w.annotations.name for w in graph.waypoints if w.annotations.name][:40],
    }


def waypoints(mission_id: str) -> list[dict]:
    """Waypoints an action can be attached to.

    Named waypoints come first: the tablet only names the ones the operator
    cared about, so those are the realistic inspection stops.
    """
    graph = _read_graph(_mission_dir(mission_id))
    out = []
    for index, wp in enumerate(graph.waypoints):
        out.append({
            "id": wp.id,
            "name": wp.annotations.name or f"Waypoint {index + 1}",
            "named": bool(wp.annotations.name),
            "index": index,
        })
    out.sort(key=lambda w: (not w["named"], w["index"]))
    return out


def list_missions() -> list[dict]:
    out = []
    for walk_dir in _walk_dirs():
        try:
            out.append(describe(walk_dir))
        except Exception as exc:
            logging.warning("Could not read mission %s: %s", walk_dir.name, exc)
            out.append({"id": walk_dir.name, "name": walk_dir.name, "playable": False,
                        "error": str(exc)})
    return out


def _mission_dir(mission_id: str) -> Path:
    # mission_id comes from the client; resolve it and refuse anything that
    # points outside the mission directory.
    root = MISSION_DIR.resolve()
    candidate = (root / mission_id).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_dir():
        raise MissionError(f"Unknown mission '{mission_id}'.")
    return candidate


# -- playback ----------------------------------------------------------------


class MissionMixin:
    """Autowalk playback for SpotController."""

    def _init_missions(self):
        self._mission_thread = None
        self._mission_cancel = threading.Event()
        self._outage_started = None
        self._mission_state = {
            "running": False,
            "mission": None,
            "status": "idle",
            "message": None,
            "uploaded": None,
            "localized": False,
            "started_at": None,
        }

    # -- status --

    def mission_status(self):
        with self._lock:
            state = dict(self._mission_state)
        state["library"] = list_missions()
        return state

    def _set_mission(self, **fields):
        with self._lock:
            self._mission_state.update(fields)

    # -- upload --

    def upload_mission(self, mission_id: str):
        """Push the graph, snapshots and walk to the robot.

        Separate from playing so the slow part happens while the operator is
        still deciding, and so an upload failure is reported on its own terms.
        """
        with self._lock:
            # Uploading does not move the robot, so it does not need the E-stop.
            # It does need the lease: the robot rejects load_autowalk with
            # 'No lease for resource "body"' without one. Requiring the lease but
            # not the E-stop lets the slow upload happen before the operator
            # arms for motion, without displacing the tablet's E-stop endpoint.
            self._require()
            if self._lease_keepalive is None:
                raise MissionError(
                    "Uploading a mission needs the body lease. Acquire it first."
                )
            graph_nav = self._graph_nav_client()
            autowalk = self._autowalk_client()

        walk_dir = _mission_dir(mission_id)
        info = describe(walk_dir)
        if not info["playable"]:
            if info["missing_snapshots"]:
                raise MissionError(
                    f"{info['missing_snapshots']} waypoint snapshots are missing from this export."
                )
            raise MissionError("This export has no autowalk file, so it cannot be played.")

        graph = _read_graph(walk_dir)
        logging.info("Uploading graph for %s: %d waypoints", mission_id, len(graph.waypoints))

        # generate_new_anchoring only when the export carries none of its own.
        response = graph_nav.upload_graph(
            graph=graph,
            generate_new_anchoring=not len(graph.anchoring.anchors),
            timeout=UPLOAD_TIMEOUT,
        )

        # The robot reports which snapshots it does not already hold, so a
        # re-upload of the same map costs almost nothing.
        for snapshot_id in response.unknown_waypoint_snapshot_ids:
            snapshot = map_pb2.WaypointSnapshot()
            snapshot.ParseFromString((walk_dir / "waypoint_snapshots" / snapshot_id).read_bytes())
            graph_nav.upload_waypoint_snapshot(waypoint_snapshot=snapshot, timeout=UPLOAD_TIMEOUT)

        for snapshot_id in response.unknown_edge_snapshot_ids:
            path = walk_dir / "edge_snapshots" / snapshot_id
            if not path.is_file():
                continue
            snapshot = map_pb2.EdgeSnapshot()
            snapshot.ParseFromString(path.read_bytes())
            graph_nav.upload_edge_snapshot(edge_snapshot=snapshot, timeout=UPLOAD_TIMEOUT)

        # Compose the tablet's walk with any actions attached in the library.
        # The export on disk is never modified; the merge happens here.
        walk = _read_walk(walk_dir)
        walk, attached = action_library.compose(walk, mission_id)
        autowalk.load_autowalk(walk, timeout=UPLOAD_TIMEOUT)

        note = f"Uploaded {info['name']}"
        if attached:
            note += f" with {attached} attached action(s)"
        self._set_mission(uploaded=mission_id, status="uploaded", localized=False, message=note)
        logging.info("Mission %s uploaded (%d attached actions)", mission_id, attached)
        return {"uploaded": mission_id, "waypoints": info["waypoints"],
                "snapshots_sent": len(response.unknown_waypoint_snapshot_ids),
                "attached_actions": attached}

    def localize_mission(self):
        """Tell the robot where it is on the map, using the nearest fiducial.

        Without this the mission cannot start. Spot needs to see a fiducial --
        in practice the dock marker, which is why starting from the dock is the
        reliable way to do this.
        """
        with self._lock:
            self._require_control()
            graph_nav = self._graph_nav_client()

        try:
            graph_nav.set_localization(
                initial_guess_localization=nav_pb2.Localization(),
                ko_tform_body=None,
                max_distance=None,
                max_yaw=None,
                fiducial_init=graph_nav_pb2.SetLocalizationRequest.FIDUCIAL_INIT_NEAREST,
            )
        except Exception as exc:
            raise MissionError(
                f"Could not localise: {exc}. Spot needs to see a fiducial — the dock marker is "
                "the usual one, so start from the dock."
            ) from exc

        self._set_mission(localized=True, status="localized",
                          message="Localised against the nearest fiducial")
        logging.info("Localized to the uploaded map")
        return {"localized": True}

    def play_mission(self, mission_id: str | None = None):
        """Start playback. Returns immediately; progress is polled."""
        with self._lock:
            self._require_control()
            if self._mission_thread and self._mission_thread.is_alive():
                raise MissionError("A mission is already running.")
            if not self._robot.is_powered_on():
                raise MissionError("Power the motors on before playing a mission.")
            if not self._mission_state["uploaded"]:
                raise MissionError("Upload a mission before playing it.")
            if not self._mission_state["localized"]:
                raise MissionError(
                    "Spot is not localised to the map. Localise first, with a fiducial in view."
                )

            mission_client = self._mission_client()
            lease_client = self._clients["lease"]
            target = mission_id or self._mission_state["uploaded"]

            self._mission_cancel = threading.Event()
            cancel = self._mission_cancel
            thread = threading.Thread(
                target=self._run_mission,
                args=(target, mission_client, lease_client, cancel),
                name=f"mission-{target}",
                daemon=True,
            )
            self._mission_thread = thread
            self._mission_state.update({
                "running": True, "mission": target, "status": "running",
                "message": "Mission started", "started_at": time.time(),
            })
            thread.start()

        self._outage_started = None
        logging.warning("Mission %s started - robot is moving autonomously", target)
        return {"running": True, "mission": target}

    def _run_mission(self, mission_id, mission_client, lease_client, cancel):
        """Drive playback to completion.

        `play_mission` only authorises a short window at a time, so this loops:
        that is what makes pause and stop take effect promptly rather than
        after the whole route.
        """
        try:
            # STATUS_PAUSED belongs here. Pausing is how this class stops a
            # mission, so any mission stopped or blocked earlier is sitting in
            # that state, still loaded and still resumable. Reading the state
            # before the first play_mission and excluding PAUSED meant the loop
            # fell straight through: play reported "finished" without ever
            # having sent a play command, and the only reason the robot moved
            # at all was the docking element.
            RESUMABLE = (mission_pb2.State.STATUS_NONE,
                         mission_pb2.State.STATUS_RUNNING,
                         mission_pb2.State.STATUS_PAUSED)

            state = self._mission_state_with_grace(mission_client, cancel)
            if state is None:
                return

            while state.status in RESUMABLE:
                if cancel.is_set():
                    mission_client.pause_mission()
                    self._set_mission(running=False, status="stopped", message="Stopped by operator")
                    logging.warning("Mission %s stopped by operator", mission_id)
                    return

                if state.questions:
                    # An unanswered operator question stalls the mission; the
                    # dashboard has no UI for answering them yet, so stop rather
                    # than sit there looking like it is still working.
                    text = "; ".join(q.text for q in state.questions)
                    mission_client.pause_mission()
                    self._set_mission(running=False, status="blocked",
                                      message=f"Mission is asking: {text}")
                    return

                try:
                    lease = lease_client.lease_wallet.advance()
                    mission_client.play_mission(time.time() + PLAY_LEASE_SECONDS, [lease])
                except Exception as exc:
                    # A dropped tick is survivable: the robot keeps running the
                    # mission on the authorisation it already has, and the next
                    # tick renews it. Only a sustained outage is fatal.
                    if not self._ride_out_outage(exc, cancel):
                        return
                    continue

                cancel.wait(POLL_INTERVAL)
                state = self._mission_state_with_grace(mission_client, cancel)
                if state is None:
                    return

            name = mission_pb2.State.Status.Name(state.status)
            ok = state.status in (mission_pb2.State.STATUS_SUCCESS, mission_pb2.State.STATUS_PAUSED)
            self._set_mission(running=False, status="finished" if ok else "failed", message=name)
            logging.info("Mission %s finished: %s", mission_id, name)
        except Exception as exc:
            logging.exception("Mission %s failed", mission_id)
            self._set_mission(running=False, status="failed", message=str(exc))

    def _ride_out_outage(self, exc, cancel):
        """Wait through a comms dropout. False once it has gone on too long."""
        started = self._outage_started or time.time()
        self._outage_started = started
        waited = time.time() - started

        if waited > COMMS_GRACE_SECONDS:
            logging.error("Robot unreachable for %.0fs, giving up: %s", waited, exc)
            self._set_mission(
                running=False, status="failed",
                message=f"Robot unreachable for {waited:.0f}s. {exc}")
            return False

        logging.warning("Robot unreachable (%.0fs of %.0fs grace): %s",
                        waited, COMMS_GRACE_SECONDS, exc)
        self._set_mission(status="running",
                          message=f"Comms lost, retrying ({waited:.0f}s)")
        cancel.wait(POLL_INTERVAL)
        return not cancel.is_set()

    def _mission_state_with_grace(self, mission_client, cancel):
        """Mission state, retried through a dropout. None means give up."""
        while True:
            try:
                state = mission_client.get_state()
            except Exception as exc:
                if not self._ride_out_outage(exc, cancel):
                    return None
                continue

            # Reached the robot, so any outage is over.
            if self._outage_started is not None:
                logging.info("Comms restored after %.0fs",
                             time.time() - self._outage_started)
                self._outage_started = None
            return state

    def pause_mission(self):
        with self._lock:
            self._require_control()
            self._mission_client().pause_mission()
            self._mission_state.update({"running": False, "status": "paused",
                                        "message": "Paused"})
        logging.info("Mission paused")
        return {"paused": True}

    def stop_mission(self):
        """Stop playback and leave the robot standing where it is."""
        with self._lock:
            self._require_control()
            self._mission_cancel.set()
            thread = self._mission_thread
        if thread and thread.is_alive():
            thread.join(timeout=3.0)
        with self._lock:
            try:
                self._mission_client().pause_mission()
            except Exception as exc:
                logging.warning("Could not pause on stop: %s", exc)
            self._mission_state.update({"running": False, "status": "stopped",
                                        "message": "Stopped by operator"})
        logging.warning("Mission stopped")
        return {"running": False}
