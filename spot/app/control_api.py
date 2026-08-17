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

import spot_control
from missions import MissionError
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
    except (ChoreographyError, MissionError) as exc:
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
