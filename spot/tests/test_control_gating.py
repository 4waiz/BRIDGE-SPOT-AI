"""The command chain: connect -> E-stop -> lease -> power -> move.

Each step is meant to be refused until the one before it is done. These tests
pin that down, because the gating is the difference between "the UI happens to
show the buttons in order" and "the robot cannot be commanded out of order".
"""

from __future__ import annotations

import pytest

import spot_control
from spot_control import SpotControlError


MOTION_COMMANDS = ["stand", "sit", "selfright", "stop"]


def test_not_connected_refuses_everything():
    """A bare controller has no robot, so nothing may be commanded."""
    ctl = spot_control.SpotController()
    for name in MOTION_COMMANDS + ["power_on", "power_off", "get_state", "undock"]:
        with pytest.raises(SpotControlError, match="Not connected"):
            getattr(ctl, name)()


@pytest.mark.parametrize("command", MOTION_COMMANDS)
def test_motion_refused_without_estop(controller, command):
    """Connected is not enough: without an E-stop endpoint there is no way to
    cut power, so motion must not be possible."""
    with pytest.raises(SpotControlError, match="Register the E-stop"):
        getattr(controller, command)()


@pytest.mark.parametrize("command", MOTION_COMMANDS)
def test_motion_refused_without_lease(controller, command):
    """E-stop alone is not enough -- another operator may hold the body."""
    controller._estop_keepalive = object()
    with pytest.raises(SpotControlError, match="Acquire the lease"):
        getattr(controller, command)()


def test_motion_allowed_once_chain_is_satisfied(controlled, fake_clients):
    """With E-stop and lease in place the command reaches the robot."""
    controlled.stand()
    assert fake_clients["command"].robot_command.called


def test_move_refused_without_control(controller):
    with pytest.raises(SpotControlError):
        controller.move(0.5, 0, 0)


def test_power_on_requires_control(controller):
    """Powering the motors is itself gated: it needs the E-stop armed first."""
    with pytest.raises(SpotControlError, match="Register the E-stop"):
        controller.power_on()


def test_credentials_required_to_connect(monkeypatch):
    """Missing credentials fail with an actionable message, not a stack trace."""
    monkeypatch.setattr(spot_control.os, "getenv", lambda key, default=None: "")
    ctl = spot_control.SpotController()
    with pytest.raises(SpotControlError, match="credentials are not configured"):
        ctl.connect()


def test_state_is_readable_without_lease_or_estop(controller, fake_clients):
    """Telemetry must not require taking control -- the UI polls it from load,
    before the operator has decided to command anything."""
    state = fake_clients["state"].get_robot_state.return_value
    state.battery_states = []
    state.estop_states = []
    state.comms_states = []
    state.system_fault_state.faults = []

    result = controller.get_state()

    assert result["connected"] is True
    assert result["lease_held"] is False
    assert result["estop"]["registered"] is False
