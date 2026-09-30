"""Running a routine: where the robot is sent, in what order, and how it stops.

The parser decides what an instruction means. This decides where that sends a
32 kg robot, and the place a bug hides is the geometry. "Forward" is forward in
the robot's own frame, but the command goes out in the odometry frame, so the
offset has to be rotated by whichever way the robot happens to be facing. Get
that wrong and a robot facing down a corridor walks sideways into the wall,
while every test run with the robot facing along x still passes. So the motion
tests below deliberately start the robot turned.
"""

from __future__ import annotations

import math
import threading
from unittest.mock import MagicMock

import pytest

from bosdyn.client.math_helpers import Quat, SE3Pose

import routines
from routines import RoutineError


def pose(x=0.0, y=0.0, yaw_deg=0.0):
    return SE3Pose(x, y, 0.0, Quat.from_yaw(math.radians(yaw_deg)))


@pytest.fixture
def goals(controlled, monkeypatch):
    """Record every goal the runner asks for, instead of moving anything."""
    sent = []
    monkeypatch.setattr(controlled, "_goto",
                        lambda goal, hint, cancel: sent.append(goal))
    return sent


def _move(controlled, goals, start, text):
    controlled._odom_pose = lambda: start
    step = routines.parse(text)[0]
    cancel = threading.Event()
    if step["kind"] == "move":
        controlled._routine_move(step, cancel)
    elif step["kind"] == "turn":
        controlled._routine_turn(step, cancel)
    return goals[-1]


# ---------------------------------------------------------------- geometry


def test_forward_facing_along_x(controlled, goals):
    goal = _move(controlled, goals, pose(1.0, 2.0, 0), "forward 2 m")
    assert (goal.x, goal.y) == pytest.approx((3.0, 2.0))


def test_forward_is_rotated_into_the_robot_heading(controlled, goals):
    """The regression that matters: a robot facing +y must walk along +y.

    Adding the offset to x without rotating it would still pass the test above,
    and would send a robot that is facing down a corridor into the wall.
    """
    goal = _move(controlled, goals, pose(1.0, 2.0, 90), "forward 2 m")
    assert (goal.x, goal.y) == pytest.approx((1.0, 4.0), abs=1e-6)


def test_forward_when_facing_backwards(controlled, goals):
    goal = _move(controlled, goals, pose(0.0, 0.0, 180), "forward 1 m")
    assert (goal.x, goal.y) == pytest.approx((-1.0, 0.0), abs=1e-6)


def test_strafe_left_is_to_the_robot_left(controlled, goals):
    # Facing +x, the robot's left is +y.
    assert (_move(controlled, goals, pose(0, 0, 0), "left 1 m").y
            == pytest.approx(1.0))
    # Facing +y, the robot's left is -x.
    goal = _move(controlled, goals, pose(0, 0, 90), "left 1 m")
    assert (goal.x, goal.y) == pytest.approx((-1.0, 0.0), abs=1e-6)


def test_moving_keeps_the_heading(controlled, goals):
    """A straight leg must not also turn the robot."""
    goal = _move(controlled, goals, pose(0, 0, 37), "forward 1 m")
    assert goal.angle == pytest.approx(math.radians(37))


def test_turns_are_relative_to_the_current_heading(controlled, goals):
    goal = _move(controlled, goals, pose(4.0, 5.0, 30), "turn left 90")
    assert goal.angle == pytest.approx(math.radians(120))
    # Turning in place stays in place.
    assert (goal.x, goal.y) == pytest.approx((4.0, 5.0))

    goal = _move(controlled, goals, pose(0, 0, 30), "turn right 45")
    assert goal.angle == pytest.approx(math.radians(-15))


def test_return_goes_back_to_where_it_started(controlled, goals):
    start = pose(1.0, 1.0, 20)
    controlled._odom_pose = lambda: pose(4.0, 3.0, 110)
    controlled._routine_return(start, threading.Event())

    goal = goals[-1]
    assert (goal.x, goal.y) == pytest.approx((1.0, 1.0))
    # And faces the way it was facing, so a repeated routine repeats.
    assert goal.angle == pytest.approx(math.radians(20))


# ---------------------------------------------------------------- the leg


def test_a_leg_sends_one_command_and_returns_on_arrival(controlled, monkeypatch):
    monkeypatch.setattr(routines, "LEG_TIMEOUT_PAD_S", 2.0)
    goal = routines.SE2Pose(x=1.0, y=0.0, angle=0.0)
    arrived = iter([pose(0.2, 0, 0), pose(0.95, 0, 0)])
    controlled._odom_pose = lambda: next(arrived, pose(1.0, 0, 0))

    controlled._goto(goal, 1.0, threading.Event())

    assert controlled._clients["command"].robot_command.call_count == 1


def test_a_leg_that_never_arrives_fails_rather_than_hanging(controlled, monkeypatch):
    monkeypatch.setattr(routines, "LEG_TIMEOUT_PAD_S", 0.5)
    monkeypatch.setattr(routines, "SPEED_MS", 100.0)      # tiny travel estimate
    controlled._odom_pose = lambda: pose(0, 0, 0)          # stuck

    with pytest.raises(RoutineError, match="did not reach"):
        controlled._goto(routines.SE2Pose(x=5.0, y=0.0, angle=0.0), 5.0,
                         threading.Event())


def test_a_leg_needs_the_estop_and_lease(controller):
    """The runner goes through the same gate as the joysticks."""
    controller._odom_pose = lambda: pose(0, 0, 0)
    with pytest.raises(Exception, match="E-stop"):
        controller._goto(routines.SE2Pose(x=1.0, y=0.0, angle=0.0), 1.0,
                         threading.Event())
    controller._clients["command"].robot_command.assert_not_called()


# ---------------------------------------------------------------- starting


def test_run_refuses_without_control(controller):
    with pytest.raises(Exception, match="E-stop"):
        controller.run_routine("forward 1 m")


def test_run_refuses_with_motors_off(controlled):
    controlled._robot.is_powered_on.return_value = False
    with pytest.raises(RoutineError, match="Power"):
        controlled.run_routine("forward 1 m")


def test_an_unreadable_instruction_never_starts(controlled):
    """Parsing happens before anything is started, so nothing half-runs."""
    with pytest.raises(RoutineError):
        controlled.run_routine("go and inspect the plant room")
    assert controlled._routine_thread is None
    assert controlled.routine_status()["status"] == "idle"


# ---------------------------------------------------------------- running


def _run_sync(controlled, text):
    """Run the body of a routine on this thread and return its final state."""
    steps = routines.parse(text)
    controlled._run_routine(text, steps, threading.Event())
    return controlled.routine_status()


def test_steps_run_in_the_order_written(controlled, monkeypatch):
    order = []
    controlled._odom_pose = lambda: pose(0, 0, 0)
    monkeypatch.setattr(controlled, "_routine_move", lambda s, c: order.append("move"))
    monkeypatch.setattr(controlled, "_routine_photo", lambda s, o, i: order.append("photo"))
    monkeypatch.setattr(controlled, "_routine_return", lambda p, c: order.append("return"))

    state = _run_sync(controlled, "forward 2 m, take a photo, come back")

    assert order == ["move", "photo", "return"]
    assert state["status"] == "finished"


def test_stop_takes_effect_before_the_next_step(controlled, monkeypatch):
    cancel = threading.Event()
    ran = []
    controlled._odom_pose = lambda: pose(0, 0, 0)

    def move_then_stop(step, c):
        ran.append(step["text"])
        cancel.set()                      # operator presses stop mid-leg

    monkeypatch.setattr(controlled, "_routine_move", move_then_stop)
    steps = routines.parse("forward 1 m, forward 1 m, forward 1 m")
    controlled._run_routine("x", steps, cancel)

    assert len(ran) == 1
    assert controlled.routine_status()["status"] == "stopped"


def test_a_failure_is_reported_and_does_not_power_off(controlled, monkeypatch):
    """A robot that sits down mid-errand is harder to recover than one standing.

    An operator is next to it; leaving it standing where it stopped is the
    kinder failure.
    """
    controlled._odom_pose = lambda: pose(0, 0, 0)

    def blocked(step, cancel):
        raise RoutineError("The robot did not reach the end of a leg in time.")

    monkeypatch.setattr(controlled, "_routine_move", blocked)
    state = _run_sync(controlled, "forward 1 m, come back")

    assert state["status"] == "failed"
    assert "did not reach" in state["message"]
    controlled._clients["power"].safe_power_off.assert_not_called()
    controlled._clients["power"].power_command.assert_not_called()


def test_no_start_pose_means_no_movement(controlled, monkeypatch):
    """Without knowing where it started, "come back" would be a guess."""
    controlled._odom_pose = lambda: None
    moved = []
    monkeypatch.setattr(controlled, "_routine_move", lambda s, c: moved.append(s))

    state = _run_sync(controlled, "forward 1 m, come back")

    assert state["status"] == "failed"
    assert moved == []


# ---------------------------------------------------------------- capture


def test_a_photo_is_saved_and_listed(controlled, monkeypatch, tmp_path):
    monkeypatch.setattr(routines, "CAPTURE_DIR", tmp_path / "routines")
    monkeypatch.setattr(routines, "SPOT_ROOT", tmp_path)
    controlled.get_image = lambda view: (b"\xff\xd8jpeg\xff\xd9", 0)

    step = routines.parse("take a thermal photo")[0]
    controlled._routine_photo(step, tmp_path / "routines" / "run", 0)

    saved = list((tmp_path / "routines" / "run").glob("*.jpg"))
    assert len(saved) == 1
    assert "cam-ir" in saved[0].name
    captures = controlled.routine_status()["captures"]
    assert captures[-1]["kind"] == "photo"
    assert captures[-1]["view"] == "cam-ir"
