"""Short errands described in words: "5 steps forward, take a photo, come back".

This is deliberately not Autowalk. An Autowalk mission needs a recorded map, a
localisation fix and a waypoint to aim at, which is a lot of apparatus for
"go and look at that thing over there". A routine is body-relative instead: it
remembers where the robot started, moves in metres and degrees from wherever it
happens to be, and can walk itself back. Nothing has to be recorded first, and
it works in places the map does not cover.

That also makes it the safer of the two on this site, where wifi has dead spots
that have put the robot on the floor: a routine is a handful of metres from the
operator rather than a 400 ft loop through the building.

The parser is keyword-based on purpose. An operator standing next to a robot
wants a command that does exactly what it says, and a wrong guess here is a
32 kg machine walking somewhere it should not. Anything it cannot read
confidently is refused and reported, never approximated.
"""

from __future__ import annotations

import logging
import math
import re
import threading
import time
from pathlib import Path

from bosdyn.client.frame_helpers import BODY_FRAME_NAME, ODOM_FRAME_NAME, get_a_tform_b
from bosdyn.client.robot_command import RobotCommandBuilder
from bosdyn.client.math_helpers import SE2Pose, SE3Pose

SPOT_ROOT = Path(__file__).resolve().parent.parent
CAPTURE_DIR = SPOT_ROOT / "data" / "routines"

# One "step" in plain speech. Spot's own stride is around this, and it makes
# "five steps forward" mean roughly what a person means by it.
STEP_M = 0.5

# Caps. A routine is an errand, not a patrol: these keep a mistyped "50" from
# sending the robot down a corridor, and keep it near enough to walk to.
MAX_LEG_M = 6.0
MAX_TOTAL_M = 30.0
MAX_TURN_DEG = 360.0
MAX_VIDEO_S = 60.0
MAX_WAIT_S = 60.0
MAX_STEPS = 40

# Motion. Slower than the robot's own default, because a routine runs close to
# whoever asked for it and often indoors.
SPEED_MS = 0.5
TURN_RATE = 0.5
# Allowed before a leg is called failed. Trajectories finish when the robot is
# within a tolerance of the goal, and an indoor floor with a door sill can take
# longer than the arithmetic suggests.
LEG_TIMEOUT_PAD_S = 12.0

VIDEO_FPS = 4.0


class RoutineError(RuntimeError):
    """Raised for an expected, reportable routine failure."""


# ---------------------------------------------------------------- parsing


# Longest first: "turn around" has to match before "turn", and "go back to
# start" before "back", or the shorter pattern wins and means something else.
_NUMBER = r"(-?\d+(?:\.\d+)?)"

# Words that describe which camera rather than what to do, so they are allowed
# to sit between the verb and the noun: "take a thermal photo". Listed rather
# than matched as "any words", because a wildcard there would swallow a clause
# like "take a look at the panel" and turn it into a photograph.
_MODS = (r"(?:(?:thermal|ir|ptz|zoom|colour|color|wide|"
         r"panoramic|pano|overlay|360)\s+)*")

_PATTERNS = [
    # return
    (re.compile(r"^(?:come|go|head)?\s*back\s+to\s+(?:the\s+)?start\b"), "return"),
    (re.compile(r"^return(?:\s+(?:to\s+)?(?:the\s+)?start)?\b"), "return"),
    (re.compile(r"^come\s+back\b"), "return"),
    (re.compile(r"^go\s+home\b"), "return"),

    # turns
    (re.compile(r"^turn\s+around\b"), "turn_around"),
    (re.compile(rf"^(?:turn|rotate|spin)\s+left\s*(?:by\s*)?{_NUMBER}?\s*(?:deg|degrees|°)?\b"), "turn_left"),
    (re.compile(rf"^(?:turn|rotate|spin)\s+right\s*(?:by\s*)?{_NUMBER}?\s*(?:deg|degrees|°)?\b"), "turn_right"),

    # capture
    # "record 8 seconds" names no noun at all, so the duration has to stand in
    # for one. Restricted to the recording verbs, or it would also swallow
    # "wait 8 seconds".
    (re.compile(rf"^(?:record|film)\s*(?:for\s*)?{_MODS}{_NUMBER}\s*"
                rf"(?:s|sec|secs|seconds)\b"), "video_bare"),
    (re.compile(rf"^(?:record|capture|take)?\s*(?:some\s+)?{_MODS}"
                rf"(?:footage|video|clip)\s*(?:for\s*)?{_NUMBER}?\s*"
                rf"(?:s|sec|secs|seconds)?\b"), "video"),
    (re.compile(rf"^(?:take|grab|capture|shoot)?\s*(?:a\s+)?{_MODS}"
                rf"(?:photo|picture|image|snap|shot)\b"), "photo"),

    # waiting
    (re.compile(rf"^(?:wait|pause|hold)\s*(?:for\s*)?{_NUMBER}?\s*(?:s|sec|secs|seconds)?\b"), "wait"),

    # translation. "N steps forward" and "forward N steps" are both natural.
    (re.compile(rf"^(?:go|move|walk|step|drive)?\s*(?:forward|forwards|ahead|straight)\s*{_NUMBER}?\s*(m|metre|metres|meter|meters|step|steps)?\b"), "forward"),
    (re.compile(rf"^{_NUMBER}\s*(m|metre|metres|meter|meters|step|steps)?\s*(?:forward|forwards|ahead|straight)\b"), "forward_n"),
    (re.compile(rf"^(?:go|move|walk|step|drive)?\s*(?:backward|backwards|back)\s*{_NUMBER}?\s*(m|metre|metres|meter|meters|step|steps)?\b"), "backward"),
    (re.compile(rf"^{_NUMBER}\s*(m|metre|metres|meter|meters|step|steps)?\s*(?:backward|backwards|back)\b"), "backward_n"),
    (re.compile(rf"^(?:go|move|walk|step|strafe)?\s*(?:left)\s*{_NUMBER}?\s*(m|metre|metres|meter|meters|step|steps)?\b"), "strafe_left"),
    (re.compile(rf"^(?:go|move|walk|step|strafe)?\s*(?:right)\s*{_NUMBER}?\s*(m|metre|metres|meter|meters|step|steps)?\b"), "strafe_right"),
]

# Which camera a capture uses. "thermal" is worth naming because it is the
# reason to send the robot at all for a lot of inspections.
_VIEWS = [
    (re.compile(r"\bthermal\s*(?:ptz|zoom)|(?:ptz|zoom)\s*thermal\b"), "cam-ptz-ir"),
    (re.compile(r"\bthermal\s*overlay\b"), "cam-ir-overlay"),
    (re.compile(r"\bthermal|\bir\b|heat"), "cam-ir"),
    (re.compile(r"\bpano|panoram"), "cam-pano"),
    (re.compile(r"\bwide|around|360"), "cam-stream"),
]
DEFAULT_VIEW = "cam-ptz"


def _split(text: str) -> list[str]:
    """Break an instruction into clauses the way someone would say it."""
    text = text.strip().lower()
    # "then" and "and" join clauses; commas, semicolons and newlines separate.
    parts = re.split(r"[,;\n]+|\bthen\b|\band\s+then\b|\band\b", text)
    return [p.strip() for p in parts if p and p.strip()]


def _distance(value: str | None, unit: str | None) -> float:
    """Metres, from a number and whatever unit the operator used."""
    amount = float(value) if value else 1.0
    if unit and unit.startswith("step"):
        return amount * STEP_M
    if unit:                       # explicit metres
        return amount
    # No unit given. "forward 3" reads as three steps in speech, not 3 metres,
    # and guessing the larger of the two is the dangerous way round.
    return amount * STEP_M


def _view_for(clause: str) -> str:
    for pattern, view in _VIEWS:
        if pattern.search(clause):
            return view
    return DEFAULT_VIEW


def parse(text: str) -> list[dict]:
    """Turn an instruction into steps, or raise explaining what was not read."""
    if not text or not text.strip():
        raise RoutineError("Nothing to do: the instruction is empty.")

    steps: list[dict] = []
    total_m = 0.0

    for clause in _split(text):
        step = _parse_clause(clause)
        if step is None:
            raise RoutineError(
                f"I could not read {clause!r}. Use plain steps such as "
                f"'forward 3 m', 'turn left 90', 'take a photo', "
                f"'record 5 seconds', or 'come back'."
            )

        if step["kind"] == "move":
            if abs(step["distance"]) > MAX_LEG_M:
                raise RoutineError(
                    f"{clause!r} asks for {abs(step['distance']):.1f} m in one leg; "
                    f"the limit is {MAX_LEG_M:.0f} m."
                )
            total_m += abs(step["distance"])
            if total_m > MAX_TOTAL_M:
                raise RoutineError(
                    f"That adds up to more than {MAX_TOTAL_M:.0f} m of walking. "
                    f"Break it into shorter routines."
                )

        steps.append(step)
        if len(steps) > MAX_STEPS:
            raise RoutineError(f"Too many steps; the limit is {MAX_STEPS}.")

    if not steps:
        raise RoutineError("Nothing to do: no steps were recognised.")
    return steps


def _parse_clause(clause: str) -> dict | None:
    for pattern, kind in _PATTERNS:
        match = pattern.match(clause)
        if not match:
            continue
        groups = match.groups()

        if kind == "return":
            return {"kind": "return", "text": "Walk back to the start"}

        if kind == "turn_around":
            return {"kind": "turn", "degrees": 180.0, "text": "Turn around"}

        if kind in ("turn_left", "turn_right"):
            degrees = float(groups[0]) if groups[0] else 90.0
            if degrees > MAX_TURN_DEG:
                degrees = MAX_TURN_DEG
            signed = degrees if kind == "turn_left" else -degrees
            way = "left" if kind == "turn_left" else "right"
            return {"kind": "turn", "degrees": signed,
                    "text": f"Turn {way} {degrees:.0f} degrees"}

        if kind in ("video", "video_bare"):
            seconds = min(float(groups[0]), MAX_VIDEO_S) if groups[0] else 5.0
            view = _view_for(clause)
            return {"kind": "video", "seconds": seconds, "view": view,
                    "text": f"Record {seconds:.0f}s of {_label(view)} footage"}

        if kind == "photo":
            view = _view_for(clause)
            return {"kind": "photo", "view": view,
                    "text": f"Take a {_label(view)} photo"}

        if kind == "wait":
            seconds = min(float(groups[0]), MAX_WAIT_S) if groups[0] else 3.0
            return {"kind": "wait", "seconds": seconds,
                    "text": f"Wait {seconds:.0f}s"}

        # Translations. The *_n variants are the "3 m forward" word order, where
        # the number comes first, so the groups sit in the same two slots.
        axis, sign = {
            "forward": ("x", 1.0), "forward_n": ("x", 1.0),
            "backward": ("x", -1.0), "backward_n": ("x", -1.0),
            "strafe_left": ("y", 1.0), "strafe_right": ("y", -1.0),
        }[kind]
        metres = _distance(groups[0], groups[1]) * sign
        way = {"x": ("Forward", "Back"), "y": ("Left", "Right")}[axis][0 if sign > 0 else 1]
        return {"kind": "move", "axis": axis, "distance": metres,
                "text": f"{way} {abs(metres):.1f} m"}

    return None


def _label(view: str) -> str:
    return {
        "cam-ptz": "colour", "cam-ir": "thermal", "cam-ptz-ir": "thermal PTZ",
        "cam-ptz-ir-color": "thermal colour", "cam-ir-overlay": "thermal overlay",
        "cam-pano": "panoramic", "cam-stream": "wide",
    }.get(view, view)


# ---------------------------------------------------------------- execution


class RoutineMixin:
    """Running a parsed routine on the robot. Mixed into SpotController."""

    def _init_routines(self):
        self._routine_thread = None
        self._routine_cancel = threading.Event()
        self._routine_state = {
            "running": False,
            "status": "idle",
            "message": None,
            "steps": [],
            "step_index": -1,
            "captures": [],
            "started_at": None,
        }

    def routine_status(self):
        with self._lock:
            return dict(self._routine_state)

    def _set_routine(self, **fields):
        with self._lock:
            self._routine_state.update(fields)

    def run_routine(self, text: str):
        """Parse and start. Returns at once; progress is polled."""
        steps = parse(text)

        with self._lock:
            self._require_control()
            if self._routine_thread and self._routine_thread.is_alive():
                raise RoutineError("A routine is already running.")
            if not self._robot.is_powered_on():
                raise RoutineError("Power the motors on before running a routine.")

            self._routine_cancel = threading.Event()
            self._routine_state.update(
                running=True, status="running", message="Starting",
                steps=steps, step_index=-1, captures=[], started_at=time.time())

            thread = threading.Thread(
                target=self._run_routine, args=(text, steps, self._routine_cancel),
                daemon=True, name="routine")
            self._routine_thread = thread
            thread.start()

        logging.warning("Routine started (%d steps) - robot is moving autonomously",
                        len(steps))
        return {"running": True, "steps": steps}

    def stop_routine(self):
        self._routine_cancel.set()
        return {"running": False}

    # -- the runner --

    def _run_routine(self, text, steps, cancel):
        stamp = time.strftime("%Y%m%d-%H%M%S")
        out = CAPTURE_DIR / stamp
        try:
            start_pose = self._odom_pose()
            if start_pose is None:
                raise RoutineError("Could not read the robot's position.")

            for index, step in enumerate(steps):
                if cancel.is_set():
                    self._set_routine(running=False, status="stopped",
                                      message="Stopped by operator")
                    return

                self._set_routine(step_index=index, message=step["text"])
                logging.info("Routine step %d/%d: %s", index + 1, len(steps), step["text"])

                kind = step["kind"]
                if kind == "move":
                    self._routine_move(step, cancel)
                elif kind == "turn":
                    self._routine_turn(step, cancel)
                elif kind == "return":
                    self._routine_return(start_pose, cancel)
                elif kind == "wait":
                    cancel.wait(step["seconds"])
                elif kind == "photo":
                    self._routine_photo(step, out, index)
                elif kind == "video":
                    self._routine_video(step, out, index, cancel)

            self._set_routine(running=False, status="finished",
                              message=f"Done, {len(steps)} steps",
                              step_index=len(steps))
            logging.info("Routine finished")

        except Exception as exc:
            logging.exception("Routine failed")
            # Leave the robot standing rather than powering it off: an operator
            # is next to it, and a robot that sits down mid-errand is harder to
            # recover than one waiting where it stopped.
            self._set_routine(running=False, status="failed", message=str(exc))

    # -- motion --

    def _odom_pose(self) -> SE3Pose | None:
        """Where the body is, in the odometry frame."""
        try:
            state = self._clients["state"].get_robot_state()
            return get_a_tform_b(state.kinematic_state.transforms_snapshot,
                                 ODOM_FRAME_NAME, BODY_FRAME_NAME)
        except Exception as exc:
            logging.warning("Could not read odometry: %s", exc)
            return None

    def _goto(self, goal: SE2Pose, distance_hint: float, cancel):
        """Walk to a pose in the odometry frame and wait for it."""
        # The float form, not synchro_se2_trajectory_command: that one wants a
        # protobuf SE2Pose and rejects the math_helpers class this module works
        # in, which failed the first leg of every routine until a test caught it.
        proto = RobotCommandBuilder.synchro_se2_trajectory_point_command(
            goal_x=goal.x, goal_y=goal.y, goal_heading=goal.angle,
            frame_name=ODOM_FRAME_NAME,
            params=RobotCommandBuilder.mobility_params())

        timeout = distance_hint / max(SPEED_MS, 0.1) + LEG_TIMEOUT_PAD_S
        end = time.time() + timeout
        with self._lock:
            self._command(proto, end_time_secs=end, description="routine leg")

        # Poll rather than trusting the timeout: arriving early is the common
        # case and waiting out the full estimate would make every routine crawl.
        while time.time() < end:
            if cancel.is_set():
                return
            pose = self._odom_pose()
            if pose is not None:
                if math.hypot(goal.x - pose.x, goal.y - pose.y) < 0.18:
                    return
            time.sleep(0.4)
        raise RoutineError("The robot did not reach the end of a leg in time.")

    def _routine_move(self, step, cancel):
        pose = self._odom_pose()
        if pose is None:
            raise RoutineError("Lost track of the robot's position.")

        # The offset is in body axes, so it has to be rotated into odometry
        # before it means anything: "forward" depends on which way it is facing.
        dx = step["distance"] if step["axis"] == "x" else 0.0
        dy = step["distance"] if step["axis"] == "y" else 0.0
        heading = pose.rot.to_yaw()
        goal = SE2Pose(
            x=pose.x + dx * math.cos(heading) - dy * math.sin(heading),
            y=pose.y + dx * math.sin(heading) + dy * math.cos(heading),
            angle=heading)
        self._goto(goal, abs(step["distance"]), cancel)

    def _routine_turn(self, step, cancel):
        pose = self._odom_pose()
        if pose is None:
            raise RoutineError("Lost track of the robot's position.")
        radians = math.radians(step["degrees"])
        goal = SE2Pose(x=pose.x, y=pose.y, angle=pose.rot.to_yaw() + radians)
        # Turning in place covers no ground, so the distance hint is the arc the
        # robot's own body sweeps, which is what sets a sensible timeout.
        self._goto(goal, abs(radians) * 0.5 / max(TURN_RATE, 0.1), cancel)

    def _routine_return(self, start_pose: SE3Pose, cancel):
        goal = SE2Pose(x=start_pose.x, y=start_pose.y,
                       angle=start_pose.rot.to_yaw())
        here = self._odom_pose()
        span = math.hypot(goal.x - here.x, goal.y - here.y) if here else MAX_TOTAL_M
        self._goto(goal, span, cancel)

    # -- capture --

    def _record_capture(self, path: Path, step, kind):
        with self._lock:
            captures = list(self._routine_state["captures"])
            captures.append({
                "kind": kind,
                "view": step.get("view"),
                "file": str(path.relative_to(SPOT_ROOT)).replace("\\", "/"),
            })
            self._routine_state["captures"] = captures

    def _routine_photo(self, step, out: Path, index: int):
        out.mkdir(parents=True, exist_ok=True)
        data, _ = self.get_image(step["view"])
        path = out / f"{index + 1:02d}_{step['view']}.jpg"
        path.write_bytes(data)
        self._record_capture(path, step, "photo")
        logging.info("Routine photo: %s", path.name)

    def _routine_video(self, step, out: Path, index: int, cancel):
        """Frames at a steady beat, written as an mp4.

        Grabbed one at a time through the same path as a still rather than a
        video stream: the robot serves stills, and at four a second that is
        enough to see what moved without competing with the control traffic for
        the wifi this site has.
        """
        import cv2
        import numpy as np

        out.mkdir(parents=True, exist_ok=True)
        deadline = time.time() + step["seconds"]
        interval = 1.0 / VIDEO_FPS
        frames = []

        while time.time() < deadline and not cancel.is_set():
            tick = time.time()
            try:
                data, _ = self.get_image(step["view"])
                frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
                if frame is not None:
                    frames.append(frame)
            except Exception as exc:
                logging.debug("Dropped a routine video frame: %s", exc)
            slept = time.time() - tick
            if slept < interval:
                cancel.wait(interval - slept)

        if not frames:
            raise RoutineError(f"No footage came back from {step['view']}.")

        height, width = frames[0].shape[:2]
        path = out / f"{index + 1:02d}_{step['view']}.mp4"
        writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"),
                                 VIDEO_FPS, (width, height))
        try:
            for frame in frames:
                # A source that changes size mid-clip would otherwise write
                # garbage frames rather than failing.
                if frame.shape[:2] != (height, width):
                    frame = cv2.resize(frame, (width, height))
                writer.write(frame)
        finally:
            writer.release()

        self._record_capture(path, step, "video")
        logging.info("Routine video: %s (%d frames)", path.name, len(frames))
