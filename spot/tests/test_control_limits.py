"""Speed clamping and command expiry.

Two properties keep manual driving survivable: the robot never exceeds the
configured speed caps no matter what the client posts, and every velocity
command carries an expiry so a dead client stops the robot instead of leaving
the last command running.
"""

from __future__ import annotations

import math

import pytest

import spot_control


@pytest.mark.parametrize(
    "v_x, v_y, v_rot",
    [
        (99.0, 99.0, 99.0),
        (-99.0, -99.0, -99.0),
        (1000.0, -1000.0, 500.0),
    ],
)
def test_move_clamps_to_configured_caps(controlled, v_x, v_y, v_rot):
    """However large the request, the result sits inside the caps."""
    result = controlled.move(v_x, v_y, v_rot)

    assert abs(result["v_x"]) <= spot_control.MAX_LINEAR
    assert abs(result["v_y"]) <= spot_control.MAX_LINEAR
    assert abs(result["v_rot"]) <= spot_control.MAX_ANGULAR


def test_move_preserves_direction_while_clamping(controlled):
    """Clamping must not flip a sign -- backwards has to stay backwards."""
    result = controlled.move(-99.0, 99.0, -99.0)

    assert result["v_x"] == -spot_control.MAX_LINEAR
    assert result["v_y"] == spot_control.MAX_LINEAR
    assert result["v_rot"] == -spot_control.MAX_ANGULAR


def test_move_passes_small_values_through(controlled):
    """A request inside the caps is honoured exactly."""
    small = spot_control.MAX_LINEAR / 4
    result = controlled.move(small, 0.0, 0.0)
    assert result["v_x"] == pytest.approx(small)


@pytest.mark.parametrize("bad", [None, "fast", float("nan")])
def test_move_rejects_junk_as_zero(controlled, bad):
    """Garbage input must coast to a stop, never become an arbitrary speed."""
    result = controlled.move(bad, bad, bad)
    assert result["v_x"] == 0.0
    assert result["v_y"] == 0.0
    assert result["v_rot"] == 0.0


def test_velocity_command_carries_expiry(controlled, fake_clients):
    """The deadman. Without end_time_secs the robot would keep executing the
    last velocity after the UI stopped talking to it."""
    controlled.move(0.2, 0.0, 0.0)

    _, kwargs = fake_clients["command"].robot_command.call_args
    assert kwargs.get("end_time_secs") is not None
    assert kwargs["end_time_secs"] > 0


def test_expiry_matches_configured_window(controlled, fake_clients):
    """The expiry is the configured window, not an arbitrary constant."""
    import time

    before = time.time()
    controlled.move(0.2, 0.0, 0.0)
    _, kwargs = fake_clients["command"].robot_command.call_args

    window = kwargs["end_time_secs"] - before
    assert window == pytest.approx(spot_control.CMD_DURATION, abs=0.5)


def test_posture_commands_have_no_expiry(controlled, fake_clients):
    """Standing is a destination, not a velocity -- it must not time out
    halfway and drop the robot."""
    controlled.stand()
    _, kwargs = fake_clients["command"].robot_command.call_args
    assert kwargs.get("end_time_secs") is None


def test_configured_caps_are_sane():
    """A misconfigured cap is a safety problem, so fail loudly on absurd ones."""
    assert 0 < spot_control.MAX_LINEAR <= 1.6, "linear cap outside a safe demo range"
    assert 0 < spot_control.MAX_ANGULAR <= 2.0, "angular cap outside a safe demo range"
    assert 0 < spot_control.CMD_DURATION <= 2.0, "command expiry too long to be a deadman"
    assert not math.isnan(spot_control.MAX_LINEAR)
