"""Reusable inspection actions for Autowalk missions.

The HSSE route as exported from the tablet walks 91 waypoints and docks, but
defines no capture actions -- it inspects nothing. This is the library that
fixes that: named, reusable action templates that get attached to waypoints and
composed into the mission at upload time.

Storage follows the same rule as the labelling tool: the tablet's `.walk` export
is never modified. Attached actions live in a sidecar JSON per mission, and the
Walk proto is composed fresh on each upload from `base walk + sidecar actions`.
That keeps the original export pristine, makes every attachment reversible, and
means a bad action can be removed without re-exporting from the tablet.

An action is an autowalk `Element`:

    Element.target        -> which waypoint to stand at (NavigateTo)
    Element.action_wrapper-> how to prepare (point the PTZ)
    Element.action        -> what to record (a data acquisition request)

The templates below fill those in from a handful of operator-facing parameters
rather than exposing the proto.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from pathlib import Path

from google.protobuf import wrappers_pb2

from bosdyn.api import data_acquisition_pb2 as daq
from bosdyn.api.autowalk import walks_pb2
from bosdyn.api.graph_nav import graph_nav_pb2
from bosdyn.api.mission import nodes_pb2 as mission_nodes_pb2
from bosdyn.api.spot_cam import ptz_pb2

# Element defaults, taken from the SDK's own record_autowalk example.
TRAVEL_MAX_DIST = 0.2          # metres of slack on arriving at a waypoint
BLOCKED_PATH_WAIT = 5          # seconds to wait for a blocked path to clear
RETRY_COUNT = 1
PROMPT_DURATION = 60           # seconds an operator question waits
BATTERY_START = 60.0           # will not begin an action below this charge
BATTERY_STOP = 10.0            # abandons the route below this charge

SPOT_ROOT = Path(__file__).resolve().parent.parent
ACTION_DIR = SPOT_ROOT / "data" / "actions"

# The Spot CAM image service, which is where the good cameras live. Body
# fisheyes come from the robot's own image service instead.
SPOT_CAM_SERVICE = "spot-cam-image"
BODY_SERVICE = "image"

_lock = threading.RLock()


class ActionError(RuntimeError):
    """Raised for expected, reportable action-library failures."""


# -- templates ---------------------------------------------------------------
#
# `params` are what the operator sets. Anything not listed is fixed by the
# template, so an action cannot be assembled into an invalid request.

TEMPLATES = {
    "ptz_capture": {
        "id": "ptz_capture",
        "title": "PTZ inspection photo",
        "blurb": "Points the Spot CAM PTZ and captures a 1920x1080 colour frame. "
                 "The workhorse for gauges, labels and equipment checks.",
        "sources": [(SPOT_CAM_SERVICE, "ptz")],
        "ptz": True,
        "params": [
            {"id": "pan", "label": "Pan", "unit": "deg", "min": 0, "max": 360, "default": 0},
            {"id": "tilt", "label": "Tilt", "unit": "deg", "min": -30, "max": 90, "default": 0},
            {"id": "zoom", "label": "Zoom", "unit": "x", "min": 1, "max": 30, "default": 1},
        ],
    },
    "thermal_capture": {
        "id": "thermal_capture",
        "title": "Thermal photo",
        "blurb": "Captures the Spot CAM IR sensor. Use for overheating bearings, "
                 "motors and electrical panels.",
        "sources": [(SPOT_CAM_SERVICE, "ir")],
        "ptz": True,
        "params": [
            {"id": "pan", "label": "Pan", "unit": "deg", "min": 0, "max": 360, "default": 0},
            {"id": "tilt", "label": "Tilt", "unit": "deg", "min": -30, "max": 90, "default": 0},
            {"id": "zoom", "label": "Zoom", "unit": "x", "min": 1, "max": 30, "default": 1},
        ],
    },
    "thermal_overlay": {
        "id": "thermal_overlay",
        "title": "Thermal + visible overlay",
        "blurb": "Thermal blended over the visible image, so a hot spot can be "
                 "tied to the thing that is hot.",
        "sources": [(SPOT_CAM_SERVICE, "ptz-ir-overlay")],
        "ptz": True,
        "params": [
            {"id": "pan", "label": "Pan", "unit": "deg", "min": 0, "max": 360, "default": 0},
            {"id": "tilt", "label": "Tilt", "unit": "deg", "min": -30, "max": 90, "default": 0},
            {"id": "zoom", "label": "Zoom", "unit": "x", "min": 1, "max": 30, "default": 1},
        ],
    },
    "panoramic": {
        "id": "panoramic",
        "title": "Panoramic sweep",
        "blurb": "The full 360 degree Spot CAM ring in one frame. Good for "
                 "housekeeping and blocked-walkway checks where the hazard "
                 "could be in any direction.",
        "sources": [(SPOT_CAM_SERVICE, "pano")],
        "ptz": False,
        "params": [],
    },
    "body_cameras": {
        "id": "body_cameras",
        "title": "Body cameras",
        "blurb": "All five body fisheyes. Low resolution and greyscale, but it "
                 "records what was around the robot at that moment.",
        "sources": [
            (BODY_SERVICE, "frontleft_fisheye_image"),
            (BODY_SERVICE, "frontright_fisheye_image"),
            (BODY_SERVICE, "left_fisheye_image"),
            (BODY_SERVICE, "right_fisheye_image"),
            (BODY_SERVICE, "back_fisheye_image"),
        ],
        "ptz": False,
        "params": [],
    },
}


def list_templates() -> list[dict]:
    """Templates as the UI shows them, without the proto detail."""
    return [
        {
            "id": t["id"],
            "title": t["title"],
            "blurb": t["blurb"],
            "params": t["params"],
            "sources": [s for _, s in t["sources"]],
            "uses_ptz": t["ptz"],
        }
        for t in TEMPLATES.values()
    ]


# -- sidecar -----------------------------------------------------------------


def aim_ptz(robot, pan: float, tilt: float, zoom: float) -> dict:
    """Point the Spot CAM PTZ, so an action can be framed before it is saved.

    Moves the camera only -- the body does not move and no lease is involved,
    which is why this is safe to drive from a preview slider. Clamped to the
    same ranges the templates expose.
    """
    from bosdyn.client.spot_cam.ptz import PtzClient

    pan = min(max(float(pan), 0.0), 360.0)
    tilt = min(max(float(tilt), -30.0), 90.0)
    zoom = min(max(float(zoom), 1.0), 30.0)

    try:
        client = robot.ensure_client(PtzClient.default_service_name)
        client.set_ptz_position(ptz_pb2.PtzDescription(name="mech"), pan, tilt, zoom)
    except Exception as exc:
        raise ActionError(f"Could not aim the camera: {exc}") from exc

    return {"pan": pan, "tilt": tilt, "zoom": zoom}


def _sidecar(mission_id: str) -> Path:
    return ACTION_DIR / f"{mission_id}.json"


def load_actions(mission_id: str) -> list[dict]:
    path = _sidecar(mission_id)
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("actions", [])
    except (OSError, ValueError) as exc:
        logging.warning("Could not read actions for %s: %s", mission_id, exc)
        return []


def _save_actions(mission_id: str, actions: list[dict]) -> None:
    with _lock:
        ACTION_DIR.mkdir(parents=True, exist_ok=True)
        path = _sidecar(mission_id)
        temp = path.with_suffix(".json.tmp")
        temp.write_text(json.dumps({"mission": mission_id, "actions": actions}, indent=2),
                        encoding="utf-8")
        os.replace(temp, path)


def add_action(mission_id: str, waypoint_id: str, template_id: str,
               name: str = "", params: dict | None = None) -> dict:
    """Attach an action to a waypoint."""
    template = TEMPLATES.get(template_id)
    if template is None:
        raise ActionError(f"Unknown action template '{template_id}'.")
    if not waypoint_id:
        raise ActionError("An action needs a waypoint to run at.")

    values = {}
    for spec in template["params"]:
        raw = (params or {}).get(spec["id"], spec["default"])
        try:
            value = float(raw)
        except (TypeError, ValueError):
            raise ActionError(f"'{spec['label']}' must be a number.") from None
        # Clamp rather than reject: an out-of-range pan is a slip, not a reason
        # to lose the rest of the action.
        values[spec["id"]] = min(max(value, spec["min"]), spec["max"])

    action = {
        "id": str(uuid.uuid4())[:8],
        "template": template_id,
        "name": name.strip() or template["title"],
        "waypoint": waypoint_id,
        "params": values,
    }

    actions = load_actions(mission_id)
    actions.append(action)
    _save_actions(mission_id, actions)
    logging.info("Action '%s' attached to %s on %s", action["name"], waypoint_id, mission_id)
    return action


def remove_action(mission_id: str, action_id: str) -> dict:
    actions = load_actions(mission_id)
    remaining = [a for a in actions if a["id"] != action_id]
    if len(remaining) == len(actions):
        raise ActionError(f"No action '{action_id}' on this mission.")
    _save_actions(mission_id, remaining)
    return {"removed": action_id, "remaining": len(remaining)}


# -- composition -------------------------------------------------------------


def _build_element(action: dict) -> walks_pb2.Element:
    """Turn a stored action into an autowalk Element.

    The robot compiles the Walk on upload and rejects it outright if an element
    is underspecified -- "the Walk was malformed", with no indication of which
    field is missing. Travel params, both failure behaviours, the battery
    monitor, the action id and the completion behaviour are all required. The
    defaults below are the SDK's own, from the record_autowalk example.
    """
    template = TEMPLATES[action["template"]]
    element = walks_pb2.Element()
    element.name = action["name"]

    # Where to stand, and how hard to try getting there.
    element.target.navigate_to.destination_waypoint_id = action["waypoint"]
    element.target.navigate_to.travel_params.max_distance = TRAVEL_MAX_DIST
    element.target.navigate_to.travel_params.feature_quality_tolerance = (
        graph_nav_pb2.TravelParams.TOLERANCE_IGNORE_POOR_FEATURE_QUALITY
    )
    element.target.navigate_to.travel_params.blocked_path_wait_time.seconds = BLOCKED_PATH_WAIT

    # What to do when it cannot. `proceed_if_able` keeps the route going rather
    # than stranding the robot mid-inspection over one unreachable waypoint.
    for behavior in (element.target_failure_behavior, element.action_failure_behavior):
        behavior.retry_count = RETRY_COUNT
        behavior.prompt_duration.seconds = PROMPT_DURATION
        behavior.proceed_if_able.SetInParent()

    # Stop the route while there is still charge to get back to the dock.
    element.battery_monitor.battery_start_threshold = BATTERY_START
    element.battery_monitor.battery_stop_threshold = BATTERY_STOP

    # How to prepare. Only templates that actually use the PTZ set it, so a
    # panoramic capture does not needlessly drive the camera first.
    if template["ptz"]:
        p = action["params"]
        element.action_wrapper.spot_cam_ptz.ptz_position.CopyFrom(
            ptz_pb2.PtzPosition(
                ptz=ptz_pb2.PtzDescription(name="mech"),
                pan=wrappers_pb2.FloatValue(value=p.get("pan", 0.0)),
                tilt=wrappers_pb2.FloatValue(value=p.get("tilt", 0.0)),
                zoom=wrappers_pb2.FloatValue(value=p.get("zoom", 1.0)),
            )
        )

    # What to record.
    request = daq.AcquireDataRequest()
    # The action name is what the capture is filed under afterwards, so without
    # it the images are unattributable.
    request.action_id.action_name = action["name"]
    for service, source in template["sources"]:
        # `order` is a CaptureOrdering message rather than an index, and is
        # optional -- left unset, the service captures in request order.
        capture = request.acquisition_requests.image_captures.add()
        capture.image_service = service
        capture.image_source = source

    element.action.data_acquisition.acquire_data_request.CopyFrom(request)
    # Wait until the capture is written before walking on, otherwise the robot
    # can leave before the image of the thing it was inspecting is saved.
    element.action.data_acquisition.completion_behavior = (
        mission_nodes_pb2.DataAcquisition.COMPLETE_AFTER_SAVED
    )
    return element


def compose(walk: walks_pb2.Walk, mission_id: str) -> tuple[walks_pb2.Walk, int]:
    """Return a copy of `walk` with the sidecar actions attached.

    Called at upload time so the tablet's export on disk is never touched.
    """
    actions = load_actions(mission_id)
    if not actions:
        return walk, 0

    composed = walks_pb2.Walk()
    composed.CopyFrom(walk)
    added = 0
    for action in actions:
        if action.get("template") not in TEMPLATES:
            logging.warning("Skipping action with unknown template: %s", action.get("template"))
            continue
        composed.elements.append(_build_element(action))
        added += 1

    logging.info("Composed %s with %d attached action(s)", mission_id, added)
    return composed, added
