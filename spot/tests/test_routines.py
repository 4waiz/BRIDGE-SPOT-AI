"""Reading an instruction into robot steps.

The parser turns typed English into motion commands for a 32 kg machine, so the
property that matters is not how much it understands. It is that it never
quietly turns an instruction into a different one. A clause it cannot read has
to be refused by name, and a distance has to come out meaning what the operator
meant, because the failure mode here is the robot walking somewhere nobody
asked it to go.
"""

from __future__ import annotations

import pytest

from routines import MAX_LEG_M, MAX_TOTAL_M, STEP_M, RoutineError, parse


def kinds(text):
    return [s["kind"] for s in parse(text)]


# ---------------------------------------------------------------- the example


def test_the_instruction_from_the_brief():
    """"5 steps forward, capture footage and photo, come back"."""
    steps = parse("5 steps forward, capture footage and photo, come back")

    assert [s["kind"] for s in steps] == ["move", "video", "photo", "return"]
    assert steps[0]["distance"] == pytest.approx(5 * STEP_M)
    assert steps[0]["axis"] == "x"


# ---------------------------------------------------------------- distances


@pytest.mark.parametrize("text, metres", [
    ("forward 3 m", 3.0),
    ("3 m forward", 3.0),
    ("forward 2 metres", 2.0),
    ("go forward 4 steps", 4 * STEP_M),
    ("4 steps forward", 4 * STEP_M),
    ("walk forward", STEP_M),
])
def test_distance_is_read_the_way_it_was_written(text, metres):
    step = parse(text)[0]
    assert step["kind"] == "move"
    assert step["distance"] == pytest.approx(metres)


def test_a_bare_number_means_steps_not_metres():
    """"forward 3" is three paces in speech.

    Reading it as three metres would make every unitless instruction six times
    longer than intended, and erring long is the dangerous direction.
    """
    assert parse("forward 3")[0]["distance"] == pytest.approx(3 * STEP_M)


def test_backwards_and_strafes_carry_the_right_sign():
    assert parse("back 2 m")[0]["distance"] == pytest.approx(-2.0)
    assert parse("left 1 m")[0]["axis"] == "y"
    assert parse("left 1 m")[0]["distance"] == pytest.approx(1.0)
    assert parse("right 1 m")[0]["distance"] == pytest.approx(-1.0)


# ---------------------------------------------------------------- turns


def test_turns():
    assert parse("turn left 90")[0]["degrees"] == pytest.approx(90.0)
    assert parse("turn right 45")[0]["degrees"] == pytest.approx(-45.0)
    assert parse("turn around")[0]["degrees"] == pytest.approx(180.0)
    # A bare "turn left" is a quarter turn, which is what it means in speech.
    assert parse("turn left")[0]["degrees"] == pytest.approx(90.0)


# ---------------------------------------------------------------- capture


def test_photo_defaults_to_the_colour_camera():
    assert parse("take a photo")[0]["view"] == "cam-ptz"


@pytest.mark.parametrize("text, view", [
    ("take a thermal photo", "cam-ir"),
    ("photo with thermal overlay", "cam-ir-overlay"),
    ("take a ptz thermal photo", "cam-ptz-ir"),
    ("take a panoramic photo", "cam-pano"),
])
def test_the_camera_can_be_named(text, view):
    assert parse(text)[0]["view"] == view


def test_video_length():
    step = parse("record 8 seconds")[0]
    assert step["kind"] == "video"
    assert step["seconds"] == pytest.approx(8.0)
    # "capture footage" with no length still has to be bounded.
    assert parse("capture footage")[0]["seconds"] > 0


# ---------------------------------------------------------------- refusal


@pytest.mark.parametrize("text", [
    "inspect the east server room",
    "check if anything looks wrong",
    "go to the loading dock",
    "do the usual round",
])
def test_an_instruction_it_cannot_follow_is_refused(text):
    """Refused by name, not approximated.

    These read like reasonable English and mean nothing to a body-relative
    runner. Turning them into some default motion is how a robot ends up
    walking into a room nobody sent it to.
    """
    with pytest.raises(RoutineError, match="could not read"):
        parse(text)


def test_an_empty_instruction_is_refused():
    with pytest.raises(RoutineError):
        parse("   ")


def test_one_unreadable_clause_refuses_the_whole_routine():
    """Partial execution is worse than none.

    Running the half it understood would leave the robot somewhere down the
    corridor having skipped the step that was supposed to bring it back.
    """
    with pytest.raises(RoutineError, match="could not read"):
        parse("forward 2 m, inspect the panel, come back")


# ---------------------------------------------------------------- limits


def test_a_single_leg_is_capped():
    with pytest.raises(RoutineError, match="limit"):
        parse(f"forward {MAX_LEG_M + 5:.0f} m")


def test_total_walking_is_capped():
    """A long routine is refused even when each leg is legal on its own."""
    legs = ", ".join(["forward 5 m"] * 10)
    with pytest.raises(RoutineError, match="more than"):
        parse(legs)


def test_a_mistyped_distance_cannot_slip_through():
    """The realistic typo: a stray zero."""
    with pytest.raises(RoutineError):
        parse("forward 50 m")


# ---------------------------------------------------------------- shape


def test_steps_carry_readable_text_for_the_operator():
    """Every step is shown before it runs, so each needs a plain description."""
    for step in parse("forward 2 m, turn left 90, take a thermal photo, come back"):
        assert step.get("text")
        assert step["text"][0].isupper()


def test_separators_people_actually_use():
    expected = ["move", "photo", "return"]
    assert kinds("forward 2 m, take a photo, come back") == expected
    assert kinds("forward 2 m then take a photo then come back") == expected
    assert kinds("forward 2 m\ntake a photo\ncome back") == expected
