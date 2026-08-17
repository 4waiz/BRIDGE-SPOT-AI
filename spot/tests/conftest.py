"""Shared fixtures for the Spot control tests.

Everything here runs without a robot. `spot_control` talks to Spot through a
handful of bosdyn service clients held in `SpotController._clients`, so the
tests build a real controller and swap those clients for mocks. That exercises
the actual gating and clamping logic rather than a reimplementation of it.

Deliberately never imports `app.py`: that module loads ~500 MB of YOLO and
TensorFlow models at import time.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

import spot_control


@pytest.fixture
def fake_clients():
    """The service clients a connected controller would hold."""
    return {
        "state": MagicMock(name="state"),
        "command": MagicMock(name="command"),
        "lease": MagicMock(name="lease"),
        "estop": MagicMock(name="estop"),
        "power": MagicMock(name="power"),
        "image": MagicMock(name="image"),
        "docking": MagicMock(name="docking"),
        "spotcam_image": MagicMock(name="spotcam_image"),
    }


@pytest.fixture
def controller(fake_clients):
    """A fresh controller in the *connected but not yet controlled* state.

    Connected, so commands get past the connection check, but with no E-stop
    endpoint and no lease -- which is exactly the state most of the gating
    tests need to prove something is refused.
    """
    ctl = spot_control.SpotController()
    ctl._robot = MagicMock(name="robot")
    ctl._robot.is_powered_on.return_value = True
    ctl._clients = fake_clients
    return ctl


@pytest.fixture
def controlled(controller):
    """A controller that has satisfied the full chain: E-stop, lease, power."""
    controller._estop_keepalive = MagicMock(name="estop_keepalive")
    controller._lease_keepalive = MagicMock(name="lease_keepalive")
    controller._robot.is_powered_on.return_value = True
    return controller
