"""Starting a mission that was stopped earlier.

Pausing is how this codebase stops a mission, so a mission that was stopped,
blocked on a question, or halted by the operator is sitting in STATUS_PAUSED,
still loaded on the robot. Pressing play again has to resume it.

It did not. The run loop read the mission state before sending anything and
looped only while the status was NONE or RUNNING, so a paused mission fell
straight through: the dashboard reported "finished" within seconds and no play
command was ever sent. On a docked robot the only visible effect was the
docking element letting go, which looks a lot like a mission that started and
gave up.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from bosdyn.api.mission import mission_pb2


def _state(status, questions=()):
    state = MagicMock(name=f"state_{status}")
    state.status = status
    state.questions = list(questions)
    return state


@pytest.fixture
def mission_client():
    return MagicMock(name="mission_client")


@pytest.fixture
def lease_client():
    client = MagicMock(name="lease_client")
    client.lease_wallet.advance.return_value = MagicMock(name="lease")
    return client


def _run_once(controller, mission_client, lease_client, first_status):
    """Drive the loop through one tick, then let it finish."""
    import threading
    cancel = threading.Event()
    mission_client.get_state.side_effect = [
        _state(first_status),
        _state(mission_pb2.State.STATUS_SUCCESS),
    ]
    controller._run_mission("M.walk", mission_client, lease_client, cancel)


def test_play_resumes_a_paused_mission(controller, mission_client, lease_client):
    """The regression: a stopped mission must be startable again."""
    _run_once(controller, mission_client, lease_client, mission_pb2.State.STATUS_PAUSED)

    assert mission_client.play_mission.called, (
        "play never reached the robot; a paused mission was treated as finished"
    )


def test_play_starts_a_fresh_mission(controller, mission_client, lease_client):
    _run_once(controller, mission_client, lease_client, mission_pb2.State.STATUS_NONE)
    assert mission_client.play_mission.called


def test_a_finished_mission_is_not_replayed(controller, mission_client, lease_client):
    """SUCCESS means done. Playing it again would send the robot back out."""
    import threading
    mission_client.get_state.return_value = _state(mission_pb2.State.STATUS_SUCCESS)

    controller._run_mission("M.walk", mission_client, lease_client, threading.Event())

    mission_client.play_mission.assert_not_called()


def test_an_unanswered_question_stops_rather_than_spinning(
        controller, mission_client, lease_client):
    """A question the dashboard cannot answer must not become a silent loop."""
    import threading
    mission_client.get_state.return_value = _state(
        mission_pb2.State.STATUS_PAUSED, questions=[MagicMock(text="Stuck. Retry?")])

    controller._run_mission("M.walk", mission_client, lease_client, threading.Event())

    status = controller.mission_status()
    assert status["status"] == "blocked"
    assert "Stuck. Retry?" in status["message"]
    mission_client.play_mission.assert_not_called()
