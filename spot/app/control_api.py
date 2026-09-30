"""HTTP surface for live robot control.

Mounted under /api/robot by app.py. Every handler here is a plain `def`, not
`async def`, on purpose: the underlying SDK calls block, and several of them
(docking, power-on) block for many seconds. FastAPI runs sync handlers in a
worker thread, which keeps one slow dock request from stalling the whole server.

Ordering enforced by spot_control: connect -> register E-stop -> acquire lease
-> power on -> move. The UI walks the operator through that sequence; the
service layer rejects anything out of order rather than trusting the client.
"""

import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

import action_library
import missions as mission_service
import routines
import spot_control
from action_library import ActionError
from missions import MissionError
from routines import RoutineError
from spot_choreography import ChoreographyError
from spot_control import LeaseHeldByOtherError, SpotControlError, controller

router = APIRouter(prefix="/api/robot", tags=["robot"])


class MoveRequest(BaseModel):
    """A joystick sample. Values are in robot body frame, metres/sec and rad/sec.

    Sent continuously while a stick is held. Values are clamped server-side, so
    out-of-range input is corrected rather than refused.
    """

    v_x: float = Field(0.0, description="Forward (+) / backward (-)")
    v_y: float = Field(0.0, description="Strafe left (+) / right (-)")
    v_rot: float = Field(0.0, description="Turn left (+) / right (-)")


class DockRequest(BaseModel):
    dock_id: int | None = Field(None, description="Defaults to SPOT_DOCK_ID from config.env")


class DanceRequest(BaseModel):
    move: str = Field(..., description="Move id from the choreography catalogue")
    duration: float | None = Field(
        None, ge=1.0, le=30.0, description="Seconds; defaults to the standard 7"
    )


def _guard(fn, *args, **kwargs):
    """Run a controller call, turning expected failures into clean HTTP errors."""
    try:
        return fn(*args, **kwargs)
    except (ChoreographyError, MissionError, ActionError, RoutineError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except LeaseHeldByOtherError as exc:
        # 423 Locked, kept distinct from the generic 409 so the UI knows it can
        # offer a forced take instead of just showing a dead end.
        raise HTTPException(status_code=423, detail=str(exc)) from exc
    except SpotControlError as exc:
        # 409: the robot is reachable but not in a state where this makes sense
        # (no lease, no E-stop, already docked, credentials missing).
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        logging.exception("Unexpected robot control failure")
        raise HTTPException(status_code=500, detail=f"Robot control error: {exc}") from exc


# -- connection -------------------------------------------------------------


@router.post("/connect")
def connect():
    return _guard(controller.connect)


@router.post("/disconnect")
def disconnect():
    return _guard(controller.disconnect)


@router.get("/state")
def state():
    """Read-only telemetry. Returns connected:false rather than erroring when
    the robot has not been connected yet, so the UI can poll this from load."""
    if not controller.is_connected:
        return {
            "connected": False,
            "ip": spot_control.SPOT_IP,
            "limits": {
                "max_linear": spot_control.MAX_LINEAR,
                "max_angular": spot_control.MAX_ANGULAR,
                "cmd_duration": spot_control.CMD_DURATION,
            },
        }
    return _guard(controller.get_state)


# -- E-stop -----------------------------------------------------------------


@router.post("/estop/register")
def estop_register():
    return _guard(controller.register_estop)


@router.post("/estop/engage")
def estop_engage():
    """Emergency stop. Cuts motor power immediately; the robot drops to a sit."""
    return _guard(controller.emergency_stop)


@router.post("/estop/clear")
def estop_clear():
    return _guard(controller.clear_estop)


@router.post("/estop/release")
def estop_release():
    return _guard(controller.release_estop)


# -- lease ------------------------------------------------------------------


@router.post("/lease/acquire")
def lease_acquire():
    """Politely acquire the lease. 423 if someone else already holds it."""
    return _guard(controller.acquire_lease, False)


@router.post("/lease/take")
def lease_take():
    """Forcibly take the lease off the current holder.

    Whoever holds it -- almost always the tablet -- loses control immediately.
    Deliberately a separate endpoint from /lease/acquire so it can never happen
    as an automatic retry; a human has to ask for it.
    """
    return _guard(controller.acquire_lease, True)


@router.post("/lease/return")
def lease_return():
    return _guard(controller.return_lease)


# -- power and posture ------------------------------------------------------


@router.post("/power/on")
def power_on():
    return _guard(controller.power_on)


@router.post("/power/off")
def power_off():
    return _guard(controller.power_off)


@router.post("/stand")
def stand():
    return _guard(controller.stand)


@router.post("/sit")
def sit():
    return _guard(controller.sit)


@router.post("/selfright")
def selfright():
    return _guard(controller.selfright)


@router.post("/stop")
def stop():
    """Halt motion, keeping power and lease. Not the E-stop."""
    return _guard(controller.stop)


# -- drive ------------------------------------------------------------------


@router.post("/move")
def move(request: MoveRequest):
    return _guard(controller.move, request.v_x, request.v_y, request.v_rot)


# -- docking ----------------------------------------------------------------


@router.post("/dock")
def dock(request: DockRequest | None = None):
    dock_id = request.dock_id if request else None
    return _guard(controller.dock, dock_id)


@router.post("/undock")
def undock():
    return _guard(controller.undock)


# -- routines ---------------------------------------------------------------


class RoutineRequest(BaseModel):
    """A short errand written in plain words."""

    text: str = Field(..., description="e.g. '5 steps forward, take a photo, come back'")


@router.post("/routine/parse")
def routine_parse(request: RoutineRequest):
    """Read an instruction into steps without touching the robot.

    Separate from running it so the operator can see exactly what was
    understood, and correct it, before a 32 kg machine acts on it.
    """
    try:
        return {"steps": routines.parse(request.text)}
    except RoutineError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/routine")
def routine_status():
    return controller.routine_status()


@router.post("/routine/run")
def routine_run(request: RoutineRequest):
    return _guard(controller.run_routine, request.text)


@router.post("/routine/stop")
def routine_stop():
    return _guard(controller.stop_routine)


@router.get("/routine/capture/{stamp}/{name}")
def routine_capture(stamp: str, name: str):
    """Serve a photo or clip a routine saved."""
    # Both parts are path segments from the client, so anything that could
    # climb out of the capture directory is refused rather than sanitised.
    if any(part in ("..", "") or "/" in part or "\\" in part for part in (stamp, name)):
        raise HTTPException(status_code=400, detail="Bad capture path.")

    path = (routines.CAPTURE_DIR / stamp / name).resolve()
    if not path.is_file() or routines.CAPTURE_DIR.resolve() not in path.parents:
        raise HTTPException(status_code=404, detail="No such capture.")

    kind = "video/mp4" if path.suffix == ".mp4" else "image/jpeg"
    return Response(content=path.read_bytes(), media_type=kind,
                    headers={"Cache-Control": "no-store"})


# -- cameras ----------------------------------------------------------------


# -- autowalk missions -------------------------------------------------------


class MissionRequest(BaseModel):
    mission: str = Field(..., description="Mission id from the library")


@router.get("/missions")
def missions():
    """The mission library plus current playback state.

    Safe to poll before connecting: the library is read from disk, so the page
    can show what is available without a robot.
    """
    return _guard(controller.mission_status)


@router.post("/missions/upload")
def mission_upload(request: MissionRequest):
    """Push the graph, snapshots and walk to the robot. Slow on first upload."""
    return _guard(controller.upload_mission, request.mission)


@router.post("/missions/localize")
def mission_localize():
    """Localise against the nearest fiducial. Required before playing."""
    return _guard(controller.localize_mission)


@router.post("/missions/play")
def mission_play(request: MissionRequest | None = None):
    """Start autonomous playback. The robot walks the recorded route unattended
    until it finishes, is paused, or is stopped."""
    return _guard(controller.play_mission, request.mission if request else None)


@router.post("/missions/pause")
def mission_pause():
    return _guard(controller.pause_mission)


@router.post("/missions/stop")
def mission_stop():
    return _guard(controller.stop_mission)


# -- inspection action library ----------------------------------------------


class AddActionRequest(BaseModel):
    mission: str
    waypoint: str
    template: str
    name: str = ""
    params: dict[str, float] | None = None


@router.get("/actions/templates")
def action_templates():
    """Reusable action definitions. Static, so no robot needed."""
    return {"templates": action_library.list_templates()}


@router.get("/actions")
def actions(mission: str):
    """Actions attached to a mission, plus the waypoints available to attach to."""
    return {
        "mission": mission,
        "actions": _guard(action_library.load_actions, mission),
        "waypoints": _guard(mission_service.waypoints, mission),
    }


@router.post("/actions")
def add_action(request: AddActionRequest):
    """Attach an action to a waypoint. Stored in a sidecar; the tablet's export
    is never modified, and the merge happens at upload time."""
    return _guard(action_library.add_action, request.mission, request.waypoint,
                  request.template, request.name, request.params)


@router.delete("/actions")
def remove_action(mission: str, action: str):
    return _guard(action_library.remove_action, mission, action)


class AimRequest(BaseModel):
    pan: float = 0.0
    tilt: float = 0.0
    zoom: float = 1.0


@router.post("/actions/aim")
def aim(request: AimRequest):
    """Point the Spot CAM PTZ so an action can be framed before saving.

    Camera only: the body does not move, so this needs a connection but not the
    lease or E-stop.
    """
    if not controller.is_connected:
        raise HTTPException(status_code=409, detail="Connect to the robot first.")
    return _guard(action_library.aim_ptz, controller._robot,
                  request.pan, request.tilt, request.zoom)


# -- choreography -----------------------------------------------------------


@router.get("/choreography")
def choreography():
    """Move catalogue with live availability, plus what is playing right now.

    Safe to poll before connecting: everything reports unavailable rather than
    erroring, so the page can render its tiles immediately.
    """
    controller.expire_dance_if_done()
    return _guard(controller.choreography_status)


@router.post("/choreography/play")
def choreography_play(request: DanceRequest):
    """Start a move, preempting whatever is already running.

    The response carries the real duration, which can differ from the request:
    fixed-length moves only fit whole repetitions and the robot may cap an
    extendable one. The UI counts down against this figure, not the request.
    """
    return _guard(controller.dance, request.move, request.duration)


@router.post("/choreography/stop")
def choreography_stop():
    """End the routine and settle into a stand."""
    return _guard(controller.stop_dance)


@router.get("/joints")
def joints():
    """Leg joint angles for the digital twin. Polled several times a second, so
    it is kept separate from the heavier /state payload."""
    if not controller.is_connected:
        return {"connected": False, "joints": {}, "body": {}}
    result = _guard(controller.get_joints)
    result["connected"] = True
    return result


@router.get("/cameras")
def cameras():
    """Views this robot can serve, so the UI can hide Spot CAM when absent."""
    if not controller.is_connected:
        return {"cameras": []}
    return {"cameras": _guard(controller.list_cameras)}


@router.get("/camera/{view}")
def camera(view: str):
    """One JPEG frame. X-Image-Rotation tells the client how far to rotate it
    for upright display, since several cameras are mounted at an angle."""
    data, rotation = _guard(controller.get_image, view)
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={
            "X-Image-Rotation": str(rotation),
            # Frames are polled; never let a proxy or the browser serve a stale one.
            "Cache-Control": "no-store",
        },
    )


# ---------------------------------------------------------------------------
# spot-voice-master integration: follow-me, on-robot speech, GraphNav.
# All the interesting logic lives in spot_voice_bridge.py; this section is
# just the HTTP shape.
# ---------------------------------------------------------------------------

import spot_voice_bridge


class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=500)


class NavigateRequest(BaseModel):
    waypoint: str = Field(..., min_length=1)


@router.post("/follow/start")
def follow_start():
    """Start the person-following background loop. Requires connect + lease + power."""
    return _guard(spot_voice_bridge.follow_session.start)


@router.post("/follow/stop")
def follow_stop():
    """Kill the follow loop and any in-flight velocity command."""
    return _guard(spot_voice_bridge.follow_session.stop)


@router.get("/follow/status")
def follow_status():
    """Whether follow-me is currently running and when it started."""
    return spot_voice_bridge.follow_session.status()


@router.post("/speak")
def speak(req: SpeakRequest):
    """Say `text` through Spot's own speaker if the payload supports it.

    Falls back to `{spoken_by: "none"}` when the CAM speaker is absent -- the
    UI plays the text through browser TTS in that case.
    """
    result = spot_voice_bridge.speak_over_spot(req.text)
    return {"text": req.text, **result}


@router.get("/waypoints")
def waypoints():
    """Named GraphNav waypoints uploaded to the robot. Empty when no map."""
    return {"waypoints": spot_voice_bridge.list_waypoints()}


@router.post("/navigate")
def navigate(req: NavigateRequest):
    """Autonomously walk to a named waypoint using GraphNav."""
    return _guard(spot_voice_bridge.navigate_to_waypoint, req.waypoint)
