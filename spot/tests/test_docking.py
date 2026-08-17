"""Docking pre-flight checks and error translation.

The docking service reports failures as numeric proto statuses. Showing those
raw ("Code: 6") tells an operator nothing, and offering a command that cannot
possibly work is worse than not offering it -- so the controller checks the
dock state first and translates whatever comes back.
"""

from __future__ import annotations

import pytest
from bosdyn.api.docking import docking_pb2

import spot_choreography  # noqa: F401  (imported for its side-effect-free registry)
import spot_control
from spot_control import SpotControlError


def set_dock_status(fake_clients, status):
    fake_clients["docking"].get_docking_state.return_value.status = status


def test_undock_refused_when_not_docked(controlled, fake_clients):
    """Answered locally and instantly, instead of by a rejected RPC."""
    set_dock_status(fake_clients, docking_pb2.DockState.DOCK_STATUS_UNDOCKED)

    with pytest.raises(SpotControlError, match="not on the dock"):
        controlled.undock()


def test_dock_refused_when_already_docked(controlled, fake_clients):
    set_dock_status(fake_clients, docking_pb2.DockState.DOCK_STATUS_DOCKED)

    with pytest.raises(SpotControlError, match="already docked"):
        controlled.dock()


def test_dock_requires_power(controlled, fake_clients):
    """Docking drives the legs, so the motors have to be live first."""
    set_dock_status(fake_clients, docking_pb2.DockState.DOCK_STATUS_UNDOCKED)
    controlled._robot.is_powered_on.return_value = False

    with pytest.raises(SpotControlError, match="Power the motors on"):
        controlled.dock()


def test_docking_state_failure_does_not_block_the_command(controlled, fake_clients):
    """If the dock state cannot be read we must not refuse on a guess -- let the
    docking service itself decide."""
    fake_clients["docking"].get_docking_state.side_effect = RuntimeError("no service")
    assert controlled._docked_status() is None


@pytest.mark.parametrize(
    "status, expected",
    [
        (docking_pb2.DockingCommandResponse.STATUS_ERROR_NOT_DOCKED, "not on the dock"),
        (docking_pb2.DockingCommandResponse.STATUS_ERROR_DOCK_NOT_FOUND, "cannot see the dock"),
        (docking_pb2.DockingCommandResponse.STATUS_ERROR_LEASE, "lease"),
        (docking_pb2.DockingCommandResponse.STATUS_ERROR_GRIPPER_HOLDING_ITEM, "gripper"),
        (docking_pb2.DockingCommandResponse.STATUS_ERROR_NOT_AVAILABLE, "not available"),
        (docking_pb2.DockingCommandResponse.STATUS_ERROR_SYSTEM, "fault"),
    ],
)
def test_every_docking_status_has_a_readable_message(status, expected):
    """Each failure the service can report maps to a sentence, not a code."""

    class FakeResponse:
        def __init__(self, s):
            self.status = s

    class FakeError(Exception):
        def __init__(self, s):
            self.response = FakeResponse(s)
            super().__init__("raw proto noise")

    message = spot_control._docking_message(FakeError(status), "Docking failed")

    assert expected in message.lower()
    assert "Code:" not in message
    assert "STATUS_ERROR" not in message


def test_unmapped_error_falls_back_rather_than_vanishing():
    """An error we did not anticipate must still reach the operator."""
    message = spot_control._docking_message(RuntimeError("transport died"), "Docking failed")
    assert "transport died" in message
