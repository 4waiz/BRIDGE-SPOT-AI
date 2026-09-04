"""Choreography (dance) control for BRIDGE SPOT.

Boston Dynamics' ChoreographyService needs a paid licence this robot does not
have, so nothing here touches it. Instead every move is scripted from the two
primitives any Spot will accept:

  * a stand command carrying a body pose (height, yaw, roll, pitch)
  * a velocity command (forward/strafe/turn)

A move is a parametric function of elapsed time. A player thread evaluates it at
TICK_HZ and streams the resulting command to the robot, which produces smooth,
continuous motion rather than a set of discrete poses. That is what makes these
read as dancing rather than twitching.

Because the moves are ours rather than the robot's, they are exactly as long as
we say -- the seven second window is honest, with no rounding to a beat.

Move families
-------------
POSE moves keep the feet planted and articulate the body. They are the safe
ones: the robot does not travel, so it cannot walk into anything.

TRAVEL moves drive the legs and do move the robot about. They stay within the
same server-side speed caps as manual driving, but they need clear space.

Safety
------
Dancing is full-body motion and goes through the same E-stop + lease + power
chain as manual driving (SpotController._require_control). Amplitudes are capped
well inside Spot's mechanical range, and the player always returns the robot to a
neutral stand when it finishes or is interrupted.
"""

import logging
import math
import threading
import time

from bosdyn.client.robot_command import RobotCommandBuilder
from bosdyn.geometry import EulerZXY

DEFAULT_DURATION = 7.0

# 20 Hz. Fast enough to look continuous, slow enough not to flood the robot.
TICK_HZ = 20.0
TICK = 1.0 / TICK_HZ

# Conservative envelopes. Spot can exceed all of these, but a demo robot in an
# office should not be pushed to its limits.
MAX_HEIGHT = 0.14      # metres of body travel from nominal
MAX_TILT = 0.38        # radians (~22 degrees) for yaw/roll/pitch
MAX_DANCE_LINEAR = 0.4   # m/s for travel moves
MAX_DANCE_ANGULAR = 0.9  # rad/s for travel moves

# Each move returns a frame: pose moves give (height, yaw, roll, pitch);
# travel moves give (v_x, v_y, v_rot). `tau` is elapsed seconds.


def _pose(height=0.0, yaw=0.0, roll=0.0, pitch=0.0):
    return {
        "kind": "pose",
        "height": max(-MAX_HEIGHT, min(MAX_HEIGHT, height)),
        "yaw": max(-MAX_TILT, min(MAX_TILT, yaw)),
        "roll": max(-MAX_TILT, min(MAX_TILT, roll)),
        "pitch": max(-MAX_TILT, min(MAX_TILT, pitch)),
    }


def _travel(v_x=0.0, v_y=0.0, v_rot=0.0):
    return {
        "kind": "travel",
        "v_x": max(-MAX_DANCE_LINEAR, min(MAX_DANCE_LINEAR, v_x)),
        "v_y": max(-MAX_DANCE_LINEAR, min(MAX_DANCE_LINEAR, v_y)),
        "v_rot": max(-MAX_DANCE_ANGULAR, min(MAX_DANCE_ANGULAR, v_rot)),
    }


# -- the twelve dances -------------------------------------------------------
# Each is a closure over elapsed time so the motion is continuous across ticks.

def _twerk(t):
    # Fast dip of the hips. abs(sin) so it drops and returns rather than rising.
    return _pose(height=-MAX_HEIGHT * abs(math.sin(t * math.pi * 2.6)))


def _sway(t):
    return _pose(roll=MAX_TILT * 0.8 * math.sin(t * math.pi * 1.4))


def _body_roll(t):
    # Yaw and roll a quarter cycle apart traces a cone: a smooth body roll.
    w = t * math.pi * 1.6
    return _pose(yaw=MAX_TILT * 0.7 * math.sin(w), roll=MAX_TILT * 0.7 * math.cos(w))


def _bow(t):
    return _pose(pitch=MAX_TILT * 0.85 * abs(math.sin(t * math.pi * 1.1)))


def _peek(t):
    # Looks side to side, with a slight lift on each turn.
    w = t * math.pi * 1.5
    return _pose(yaw=MAX_TILT * math.sin(w), height=0.04 * math.cos(w * 2))


def _bounce(t):
    return _pose(height=MAX_HEIGHT * 0.9 * math.sin(t * math.pi * 2.0))


def _wave(t):
    # Roll paired with height gives a rolling-wave feel through the body.
    w = t * math.pi * 1.8
    return _pose(roll=MAX_TILT * 0.65 * math.sin(w), height=MAX_HEIGHT * 0.6 * math.sin(w + math.pi / 2))


def _figure8(t):
    # Lissajous 1:2 — the classic figure of eight.
    w = t * math.pi * 1.2
    return _pose(yaw=MAX_TILT * 0.8 * math.sin(w), pitch=MAX_TILT * 0.5 * math.sin(w * 2))


def _spin(t):
    # Turns one way, then back, so it finishes near where it started.
    return _travel(v_rot=MAX_DANCE_ANGULAR * math.sin(t * math.pi * 0.6))


def _shimmy(t):
    return _travel(v_y=MAX_DANCE_LINEAR * math.sin(t * math.pi * 2.2))


def _tap_step(t):
    return _travel(v_x=MAX_DANCE_LINEAR * 0.8 * math.sin(t * math.pi * 2.4))


def _disco(t):
    # Strafe and turn together: the busiest of the set.
    return _travel(
        v_y=MAX_DANCE_LINEAR * 0.75 * math.sin(t * math.pi * 2.0),
        v_rot=MAX_DANCE_ANGULAR * 0.6 * math.cos(t * math.pi * 1.4),
    )


# -- basics ------------------------------------------------------------------

def _look_up(t):
    return _pose(pitch=-MAX_TILT * 0.7)


def _look_down(t):
    return _pose(pitch=MAX_TILT * 0.7)


def _crouch(t):
    return _pose(height=-MAX_HEIGHT)


def _tall(t):
    return _pose(height=MAX_HEIGHT)


def _centre(t):
    return _pose()


# Payload-safe subset. This Spot carries the CAM+ 360 payload (caged PTZ
# camera + electronics module + isolator-mounted base plate) on its back
# rails. Bounces, whip-fast turns and repeated foot impacts oscillate the
# payload on its isolators and put shear load on the rail clamps -- which
# is fine for the robot but not for a ~$40k camera. So the routines that
# used to be here (twerk, bounce, wave, spin, shimmy, tap_step, disco) are
# deliberately left out of the exposed catalogue. Their _fn helpers stay
# defined below in case a future payload-off configuration wants to opt
# back in; ALL_MOVES only maps what's in this list, so the API refuses to
# play the removed ones even if the frontend gets stale.
DANCES = [
    {"id": "sway", "label": "Sway", "emoji": "🌊", "fn": _sway, "energy": "low",
     "blurb": "Rolls the body smoothly side to side.", "travels": False},
    {"id": "body_roll", "label": "Body Roll", "emoji": "🌀", "fn": _body_roll, "energy": "medium",
     "blurb": "Yaw and roll combine into a slow cone.", "travels": False},
    {"id": "bow", "label": "Bow", "emoji": "🙇", "fn": _bow, "energy": "low",
     "blurb": "Pitches forward into a bow, then rises.", "travels": False},
    {"id": "peek", "label": "Peek-a-boo", "emoji": "👀", "fn": _peek, "energy": "low",
     "blurb": "Looks left and right with a lift on each turn.", "travels": False},
    {"id": "figure8", "label": "Figure 8", "emoji": "8️⃣", "fn": _figure8, "energy": "medium",
     "blurb": "Traces a figure of eight with the body.", "travels": False},
]

BASICS = [
    {"id": "centre", "label": "Centre", "emoji": "🎯", "fn": _centre, "energy": "low",
     "blurb": "Return to a neutral stand.", "travels": False},
    {"id": "look_up", "label": "Look Up", "emoji": "⬆️", "fn": _look_up, "energy": "low",
     "blurb": "Tilt the body to look upward.", "travels": False},
    {"id": "look_down", "label": "Look Down", "emoji": "⬇️", "fn": _look_down, "energy": "low",
     "blurb": "Tilt the body to look at the floor.", "travels": False},
    {"id": "crouch", "label": "Crouch", "emoji": "🔽", "fn": _crouch, "energy": "low",
     "blurb": "Lower the body on its legs.", "travels": False},
    {"id": "tall", "label": "Tall", "emoji": "🔼", "fn": _tall, "energy": "low",
     "blurb": "Raise the body to full height.", "travels": False},
]

ALL_MOVES = {m["id"]: m for m in DANCES + BASICS}


class ChoreographyError(RuntimeError):
    """Raised for expected, reportable choreography failures."""


class ChoreographyMixin:
    """Scripted dance behaviour for SpotController.

    A mixin so connection, lease and E-stop handling stay in one place instead of
    being duplicated for dancing.
    """

    def _init_choreography(self, robot=None, sdk=None):
        """Reset dance state. Nothing to negotiate with the robot: the moves are
        built from ordinary commands, so they work on any Spot that can stand."""
        self._dance_thread = None
        self._dance_cancel = threading.Event()
        self._dance_current = None
        self._dance_until = 0.0

    # -- catalogue ----------------------------------------------------------

    def choreography_status(self):
        with self._lock:
            playing = self._dance_current
            remaining = max(0.0, self._dance_until - time.time()) if playing else 0.0

            def present(entry):
                return {
                    "id": entry["id"],
                    "label": entry["label"],
                    "emoji": entry["emoji"],
                    "blurb": entry["blurb"],
                    "energy": entry["energy"],
                    "travels": entry["travels"],
                    # Every move is scripted locally, so availability depends
                    # only on being connected -- no licence, no robot feature.
                    "available": self.is_connected,
                }

            return {
                "connected": self.is_connected,
                "ready": self.is_connected,
                "duration": DEFAULT_DURATION,
                "playing": playing,
                "remaining": round(remaining, 2),
                "dances": [present(d) for d in DANCES],
                "basics": [present(b) for b in BASICS],
            }

    # -- playback -----------------------------------------------------------

    def dance(self, move_id, duration=None):
        """Play a move for `duration` seconds, interrupting anything running."""
        with self._lock:
            self._require_control()
            if not self._robot.is_powered_on():
                raise ChoreographyError("Power the motors on before dancing.")

            move = ALL_MOVES.get(move_id)
            if move is None:
                raise ChoreographyError(f"Unknown move '{move_id}'.")

            seconds = float(duration or DEFAULT_DURATION)

            # Stop the previous player before starting another, so two threads
            # never stream conflicting commands to the robot.
            self._halt_dance_thread()

            self._dance_cancel = threading.Event()
            cancel = self._dance_cancel
            command_client = self._clients["command"]

            thread = threading.Thread(
                target=self._run_dance,
                args=(move, seconds, cancel, command_client),
                name=f"dance-{move_id}",
                daemon=True,
            )
            self._dance_thread = thread
            self._dance_current = move_id
            self._dance_until = time.time() + seconds
            thread.start()

            logging.info("Dancing '%s' for %.1fs", move["label"], seconds)
            return {
                "playing": move_id,
                "label": move["label"],
                "duration": round(seconds, 2),
                "travels": move["travels"],
                "started_in": 0.0,
            }

    def _run_dance(self, move, seconds, cancel, command_client):
        """Stream the move to the robot until it finishes or is cancelled.

        Runs off the request thread so an HTTP call is not held open for the
        whole routine, and deliberately does not hold the controller lock: it
        would block telemetry polling for the entire dance.
        """
        started = time.time()
        fn = move["fn"]
        try:
            while not cancel.is_set():
                tau = time.time() - started
                if tau >= seconds:
                    break

                frame = fn(tau)
                if frame["kind"] == "pose":
                    command = RobotCommandBuilder.synchro_stand_command(
                        body_height=frame["height"],
                        footprint_R_body=EulerZXY(
                            yaw=frame["yaw"], roll=frame["roll"], pitch=frame["pitch"]
                        ),
                    )
                    command_client.robot_command(command=command)
                else:
                    command = RobotCommandBuilder.synchro_velocity_command(
                        v_x=frame["v_x"], v_y=frame["v_y"], v_rot=frame["v_rot"]
                    )
                    # Velocity commands must carry an expiry: if this thread
                    # dies mid-move the robot stops rather than running on.
                    command_client.robot_command(
                        command=command, end_time_secs=time.time() + 0.25
                    )

                cancel.wait(TICK)
        except Exception as exc:
            logging.warning("Dance '%s' ended early: %s", move["label"], exc)
        finally:
            # Always settle back to neutral, whether we finished or were cut off.
            # A cancelled move skips this because the incoming move is about to
            # take over and an intervening stand would show as a visible hitch.
            if not cancel.is_set():
                try:
                    command_client.robot_command(
                        command=RobotCommandBuilder.synchro_stand_command()
                    )
                except Exception as exc:
                    logging.warning("Could not settle after dance: %s", exc)
                with self._lock:
                    if self._dance_current == move["id"]:
                        self._dance_current = None
                        self._dance_until = 0.0

    def _halt_dance_thread(self):
        """Signal the current player to stop and wait briefly for it to exit."""
        if self._dance_thread and self._dance_thread.is_alive():
            self._dance_cancel.set()
            # Slightly over one tick: long enough for a clean exit, short enough
            # that switching moves still feels instant.
            self._dance_thread.join(timeout=TICK * 3)
        self._dance_thread = None

    def stop_dance(self):
        """End the routine and settle into a neutral stand."""
        with self._lock:
            self._require_control()
            self._halt_dance_thread()
            self._dance_current = None
            self._dance_until = 0.0
            try:
                self._clients["command"].robot_command(
                    command=RobotCommandBuilder.synchro_stand_command()
                )
            except Exception as exc:
                raise ChoreographyError(f"Could not stop the routine: {exc}") from exc
            logging.info("Dance stopped, standing")
            return {"playing": None}

    def expire_dance_if_done(self):
        """Keep the reported status honest once a routine's window has passed."""
        with self._lock:
            if self._dance_current and time.time() >= self._dance_until:
                if not (self._dance_thread and self._dance_thread.is_alive()):
                    self._dance_current = None
                    self._dance_until = 0.0
