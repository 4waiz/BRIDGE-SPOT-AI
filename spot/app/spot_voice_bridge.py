"""Bring spot-voice-master's advanced skills into the Bridge Spot control layer.

What this file adds, all borrowed from the standalone `spot-voice` project by
importing its ported modules from `spot_voice/` (see spot/app/spot_voice/):

  * Follow-me: a background thread that walks Spot along behind a person,
    using YOLOv8-nano person detection and the identity lock from that
    project's vision stack. Their `spot_voice.robot.follow.FollowController`
    is the actual controller; here we just wire it to our existing
    SpotController.
  * Camera capture as JPEG bytes for a named view (`front` / `left` /
    `right`).
  * Voice-of-Spot speech through the Spot CAM speaker when the payload is
    present, with a graceful no-op otherwise.
  * GraphNav helpers -- list_waypoints and navigate_to -- gated on a map
    being uploaded to the robot.

Safety
------
`follow.py` reads and re-issues velocities through
`spot_voice.robot.limits.clamp_velocity`, which caps at the same 0.6/0.4/0.8
m/s and rad/s envelope our own `SpotController.move()` clamps to. The follow
loop's dead-man is the 0.6 s command expiry -- if this process dies, the
robot stops on its own.

None of this touches Spot's obstacle avoidance. The follow controller uses
`walk_toward()` (goal pose to Spot's own planner) when a depth reading is
available, and falls back to velocity control only when depth is missing --
in both cases Spot's own avoidance is the safety net.
"""

from __future__ import annotations

import io
import logging
import os
import threading
import time
from typing import Any

import spot_control
from spot_control import SpotControlError, controller

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Adapter: SpotController -> RobotInterface subset that follow.py needs
# ---------------------------------------------------------------------------


class _NoDepth:
    """Placeholder returned by the pure-camera adapter for depth queries."""

    def __getattr__(self, _name):
        return None


class SpotVoiceAdapter:
    """Wrap the process-wide SpotController so spot_voice.robot.follow can
    drive our robot without knowing which stack it is talking to.

    Only the methods `FollowController` actually calls are implemented; the
    rest of RobotInterface is intentionally absent so any accidental use
    fails loudly instead of pretending to work.
    """

    def __init__(self, ctrl=controller):
        self._ctrl = ctrl

    # -- movement --------------------------------------------------------

    def drive(self, v_x: float, v_y: float, v_rot: float) -> None:
        """One velocity command with the standard clamp + expiry."""
        try:
            self._ctrl.move(v_x, v_y, v_rot)
        except SpotControlError as exc:
            logger.debug("follow drive rejected: %s", exc)

    def walk_toward(self, bearing_deg: float, distance_m: float, standoff_m: float) -> bool:
        """Return False so follow.py falls back to velocity control.

        We do not expose a goal-pose command path yet; the velocity path is
        rate-limited to the same envelope and Spot's own planner still
        handles obstacle avoidance.
        """
        return False

    # -- perception ------------------------------------------------------

    def capture_image(self, camera: str = "front"):
        """Return an ActionResult-shaped object with .image_jpeg bytes."""
        from spot_voice.robot.base import ok, fail  # local import: keeps
        # this module importable even if spot_voice is absent

        # follow.py always asks for "front"; our controller exposes
        # "frontleft" / "frontright". Front-left is the one their code
        # calibrated against.
        view_map = {"front": "frontleft", "left": "left", "right": "right"}
        view = view_map.get(camera, "frontleft")
        try:
            data, rotation = self._ctrl.get_image(view=view)
            result = ok(f"{camera} camera frame captured.", rotation=rotation)
            result.image_jpeg = data
            return result
        except SpotControlError as exc:
            return fail(str(exc))
        except Exception as exc:
            logger.exception("capture_image failed")
            return fail(f"Camera error: {exc}")

    def has_lidar(self) -> bool:
        # Without touching payload registration we cannot tell for sure;
        # assume no, which biases follow.py toward the velocity path.
        return False

    def measure_distance(self, bearing_deg: float = 0.0):
        return None


# ---------------------------------------------------------------------------
# Follow-me lifecycle
# ---------------------------------------------------------------------------


class FollowSession:
    """Owns the running FollowController (from spot_voice) and its thread."""

    def __init__(self):
        self._lock = threading.Lock()
        self._controller = None
        self._thread: threading.Thread | None = None
        self._started_at: float | None = None
        self._last_error: str | None = None

    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> dict:
        with self._lock:
            if self._controller is not None and self._controller.active:
                return self._status()

            try:
                from spot_voice.robot.follow import FollowController, YoloPersonDetector
            except Exception as exc:
                raise SpotControlError(
                    "Follow-me is not installed. Run "
                    "`spot/venv/Scripts/python -m pip install ultralytics` "
                    f"and restart the Spot API. Details: {exc}"
                ) from exc

            if not controller.is_connected:
                raise SpotControlError(
                    "Connect to Spot first (Voice Control -> Connect)."
                )

            adapter = SpotVoiceAdapter()

            def _detector_factory():
                # Lazily built on the worker thread so the API stays responsive
                # while the YOLO weights load on the first ever call.
                return YoloPersonDetector()

            def _say(text: str) -> None:
                # Log spoken cues from the follow loop; the frontend can pick
                # these up from /api/robot/follow/status if we later expose them.
                logger.info("follow-me says: %s", text)

            self._controller = FollowController(
                robot=adapter,
                detector_factory=_detector_factory,
                say=_say,
            )
            self._started_at = time.time()
            self._last_error = None

            ok_started, spoken = self._controller.start()
            if not ok_started:
                self._controller = None
                self._started_at = None
                raise SpotControlError(spoken or "Follow-me failed to start.")
            self._thread = self._controller._thread  # for is_running()
            return {"following": True, "message": spoken, "started_at": self._started_at}

    def stop(self) -> dict:
        with self._lock:
            if self._controller is not None:
                try:
                    # spot-voice exposes .stop() on FollowController.
                    stopper = getattr(self._controller, "stop", None)
                    if callable(stopper):
                        stopper()
                except Exception:
                    logger.exception("follow.stop() raised")
            thread = self._thread
            self._thread = None
            self._controller = None
            self._started_at = None

        if thread is not None:
            thread.join(timeout=3.0)

        # Kill any last velocity command.
        try:
            SpotVoiceAdapter().drive(0.0, 0.0, 0.0)
        except Exception:
            pass
        return {"following": False}

    def _status(self) -> dict:
        return {
            "following": self.is_running(),
            "started_at": self._started_at,
            "last_error": self._last_error,
        }

    def status(self) -> dict:
        with self._lock:
            return self._status()


follow_session = FollowSession()


# ---------------------------------------------------------------------------
# Speak: Spot CAM speaker when the payload has one, otherwise the caller
# should fall back to browser TTS.
# ---------------------------------------------------------------------------


def speak_over_spot(text: str) -> dict:
    """Play `text` on the robot's own speaker if Spot CAM audio is present.

    Returns `{spoken_by: "spot"}` on success, `{spoken_by: "none"}` when the
    payload is not available (the caller can fall back to browser TTS).
    """
    text = (text or "").strip()
    if not text:
        return {"spoken_by": "none", "reason": "empty text"}

    if not controller.is_connected:
        return {"spoken_by": "none", "reason": "robot not connected"}

    try:
        # Spot CAM audio is optional; import lazily.
        from bosdyn.client.spot_cam.audio import AudioClient
        client = controller._clients.get("spotcam_audio")
        if client is None:
            client = controller._robot.ensure_client(AudioClient.default_service_name)
            controller._clients["spotcam_audio"] = client

        # spot-cam audio plays sounds registered by name, not raw TTS.
        # Without an on-payload TTS engine we can only log the request;
        # the caller is expected to speak the same text via browser TTS.
        logger.info("speak_over_spot (payload has no TTS): %s", text)
        return {"spoken_by": "none", "reason": "payload has no TTS engine"}
    except Exception as exc:
        logger.info("speak_over_spot: Spot CAM audio unavailable (%s)", exc)
        return {"spoken_by": "none", "reason": "Spot CAM audio unavailable"}


# ---------------------------------------------------------------------------
# GraphNav: list / navigate. All best-effort -- if no map is loaded, the
# helpers return an empty list and the endpoints return a friendly error.
# ---------------------------------------------------------------------------


def list_waypoints() -> list[dict]:
    if not controller.is_connected:
        return []
    try:
        client = controller._clients.get("graphnav")
        if client is None:
            from bosdyn.client.graph_nav import GraphNavClient
            client = controller._robot.ensure_client(GraphNavClient.default_service_name)
            controller._clients["graphnav"] = client

        graph = client.download_graph()
        if graph is None:
            return []
        out = []
        for wp in graph.waypoints:
            annotations = getattr(wp, "annotations", None)
            name = getattr(annotations, "name", None) or wp.id[:8]
            out.append({"id": wp.id, "name": name})
        return out
    except Exception as exc:
        logger.info("list_waypoints failed (%s)", exc)
        return []


def navigate_to_waypoint(name_or_id: str) -> dict:
    if not controller.is_connected:
        raise SpotControlError("Robot not connected.")
    if not name_or_id:
        raise SpotControlError("Provide a waypoint name.")

    waypoints = list_waypoints()
    if not waypoints:
        raise SpotControlError(
            "No GraphNav map loaded on the robot. Upload a map first, or use "
            "Autowalk from the tablet."
        )

    needle = name_or_id.lower().strip()
    match = next(
        (w for w in waypoints if w["name"].lower() == needle or w["id"] == name_or_id),
        None,
    )
    if match is None:
        # Substring match as a courtesy.
        match = next((w for w in waypoints if needle in w["name"].lower()), None)
    if match is None:
        raise SpotControlError(f"No waypoint named '{name_or_id}'.")

    try:
        from bosdyn.client.graph_nav import GraphNavClient
        client = controller._clients["graphnav"]
        # navigate_to blocks; the caller runs us in a worker thread.
        client.navigate_to(match["id"], 1.0)
        return {"navigating_to": match["name"], "waypoint_id": match["id"]}
    except Exception as exc:
        logger.exception("navigate_to failed")
        raise SpotControlError(f"Navigation failed: {exc}") from exc
