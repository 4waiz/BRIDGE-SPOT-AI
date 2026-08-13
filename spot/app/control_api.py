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
from spot_control import SpotControlError, controller

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


def _guard(fn, *args, **kwargs):
    """Run a controller call, turning expected failures into clean HTTP errors."""
    try:
        return fn(*args, **kwargs)
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
    return _guard(controller.acquire_lease)


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
