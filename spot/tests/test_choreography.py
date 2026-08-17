"""Dance moves stay inside their envelope and behind the same gating.

The moves are scripted locally rather than run by Spot's licensed choreography
service, which means the amplitudes are ours to get wrong. These tests sample
every move across its whole window and fail if any frame leaves the envelope.
"""

from __future__ import annotations

import pytest

import spot_choreography as choreo
from spot_choreography import ChoreographyError


ALL = choreo.DANCES + choreo.BASICS
SAMPLE_SECONDS = [i * 0.1 for i in range(int(choreo.DEFAULT_DURATION * 10) + 1)]


def test_catalogue_is_the_promised_shape():
    assert len(choreo.DANCES) == 12, "the page advertises twelve dances"
    assert len(choreo.BASICS) >= 1
    ids = [m["id"] for m in ALL]
    assert len(ids) == len(set(ids)), "duplicate move ids"


@pytest.mark.parametrize("move", ALL, ids=lambda m: m["id"])
def test_every_frame_stays_inside_the_envelope(move):
    """Sampled across the full seven seconds, not just at t=0."""
    for tau in SAMPLE_SECONDS:
        frame = move["fn"](tau)

        if frame["kind"] == "pose":
            assert abs(frame["height"]) <= choreo.MAX_HEIGHT
            assert abs(frame["yaw"]) <= choreo.MAX_TILT
            assert abs(frame["roll"]) <= choreo.MAX_TILT
            assert abs(frame["pitch"]) <= choreo.MAX_TILT
        else:
            assert abs(frame["v_x"]) <= choreo.MAX_DANCE_LINEAR
            assert abs(frame["v_y"]) <= choreo.MAX_DANCE_LINEAR
            assert abs(frame["v_rot"]) <= choreo.MAX_DANCE_ANGULAR


@pytest.mark.parametrize("move", ALL, ids=lambda m: m["id"])
def test_frames_are_finite(move):
    """A NaN reaching the robot would be an undefined pose."""
    for tau in SAMPLE_SECONDS:
        for key, value in move["fn"](tau).items():
            if key == "kind":
                continue
            assert value == value, f"{move['id']} produced NaN for {key}"
            assert abs(value) != float("inf")


@pytest.mark.parametrize("move", ALL, ids=lambda m: m["id"])
def test_travel_flag_matches_the_frames(move):
    """The UI tells the operator whether a move stays put. That claim has to be
    true, because it is what they use to decide if there is room."""
    kinds = {move["fn"](t)["kind"] for t in SAMPLE_SECONDS}
    if move["travels"]:
        assert kinds == {"travel"}
    else:
        assert kinds == {"pose"}, f"{move['id']} is advertised as stationary but drives the legs"


def test_dance_envelope_is_conservative():
    """These caps are the whole safety story for dancing."""
    assert 0 < choreo.MAX_HEIGHT <= 0.2
    assert 0 < choreo.MAX_TILT <= 0.5
    assert 0 < choreo.MAX_DANCE_LINEAR <= 0.6
    assert 0 < choreo.MAX_DANCE_ANGULAR <= 1.2


def test_dancing_needs_the_same_control_chain(controller):
    """Voice, buttons or dance -- motion is gated identically."""
    with pytest.raises(Exception, match="E-stop"):
        controller.dance("sway")


def test_dancing_needs_power(controlled):
    controlled._robot.is_powered_on.return_value = False
    with pytest.raises(ChoreographyError, match="Power the motors on"):
        controlled.dance("sway")


def test_unknown_move_is_refused(controlled):
    """Only catalogue entries are playable; an id from nowhere runs nothing."""
    with pytest.raises(ChoreographyError, match="Unknown move"):
        controlled.dance("moonwalk")


def test_status_reports_unavailable_before_connecting():
    ctl = __import__("spot_control").SpotController()
    status = ctl.choreography_status()
    assert status["connected"] is False
    assert all(not d["available"] for d in status["dances"])
