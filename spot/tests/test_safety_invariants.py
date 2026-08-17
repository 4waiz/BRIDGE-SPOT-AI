"""Safety guarantees checked against the source itself.

These are not behaviour tests. They read the project's own code and fail if a
promise made elsewhere quietly stops being true. That matters here because the
promises are cheap to make, easy to erode, and the thing on the other end of
them weighs 32 kg and walks.

Modelled on the same idea in the vendored spot-voice project.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parent.parent / "app"
FRONTEND = Path(__file__).resolve().parent.parent / "frontend"

#: Fields of bosdyn's MobilityParams that weaken or switch off Spot's own
#: obstacle and cliff avoidance. This project must never set one.
AVOIDANCE_FIELDS = (
    "disable_vision_foot_obstacle_avoidance",
    "disable_vision_foot_constraint_avoidance",
    "disable_vision_body_obstacle_avoidance",
    "disable_vision_foot_obstacle_body_assist",
    "disable_vision_negative_obstacles",
    "obstacle_avoidance_padding",
    "allow_degraded_perception",
    "disable_nearmap_cliff_avoidance",
    "disable_missing_data_cliffs",
)

#: Public methods on SpotController that physically move the robot. Every one
#: must sit behind the E-stop + lease gate.
MOTION_METHODS = (
    "stand", "sit", "selfright", "stop", "move",
    "power_on", "power_off", "dock", "undock", "dance", "stop_dance",
)


def python_sources() -> list[Path]:
    return sorted(p for p in APP.glob("*.py") if p.name != "__init__.py")


def test_there_is_source_to_check():
    assert len(python_sources()) >= 5


@pytest.mark.parametrize("field", AVOIDANCE_FIELDS)
def test_obstacle_avoidance_is_never_disabled(field):
    """Spot avoids obstacles on its own. Nothing here may switch that off."""
    for path in python_sources():
        text = path.read_text(encoding="utf-8", errors="replace")
        assert field not in text, f"{path.name} touches {field}"


def test_no_hardcoded_credentials():
    """Credentials come from config.env, which is gitignored."""
    pattern = re.compile(
        r"""(password|passwd|secret|api_key)\s*=\s*["'][^"'\s]{6,}["']""", re.I
    )
    for path in python_sources():
        for number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            if "getenv" in line or "environ" in line:
                continue          # reading one from the environment is the point
            assert not pattern.search(line), f"{path.name}:{number} looks like a literal credential"


def _method_bodies(path: Path) -> dict[str, ast.FunctionDef]:
    tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    found: dict[str, ast.FunctionDef] = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            found[node.name] = node
    return found


def test_every_motion_method_is_gated():
    """A motion method must reach the gate, directly or through the `_command`
    helper. Adding a new one that skips it should fail the build."""
    methods = {}
    for path in (APP / "spot_control.py", APP / "spot_choreography.py"):
        methods.update(_method_bodies(path))

    for name in MOTION_METHODS:
        node = methods.get(name)
        assert node is not None, f"{name} has gone missing from the controller"

        calls = {
            child.func.attr
            for child in ast.walk(node)
            if isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute)
        }
        gated = "_require_control" in calls or "_command" in calls
        assert gated, f"{name} does not go through _require_control or _command"


def test_the_command_helper_itself_enforces_the_gate():
    """Most motion methods delegate to `_command`, so checking only that they
    call it would pass even if the gate were removed from the helper. This
    closes that hole: `_command` must call `_require_control` itself."""
    node = _method_bodies(APP / "spot_control.py")["_command"]
    calls = {
        child.func.attr
        for child in ast.walk(node)
        if isinstance(child, ast.Call) and isinstance(child.func, ast.Attribute)
    }
    assert "_require_control" in calls, "_command no longer enforces the control gate"


def test_velocity_commands_carry_an_expiry():
    """Every synchro_velocity_command must be paired with end_time_secs in the
    same function -- that pairing is the deadman."""
    for path in (APP / "spot_control.py", APP / "spot_choreography.py"):
        for name, node in _method_bodies(path).items():
            source = ast.unparse(node)
            if "synchro_velocity_command" not in source:
                continue
            assert "end_time_secs" in source, (
                f"{path.name}:{name} sends a velocity with no expiry"
            )


def test_estop_takeover_is_confined_to_registration():
    """force_simple_setup displaces every other software E-stop endpoint,
    including the tablet's. It belongs in exactly one place."""
    text = (APP / "spot_control.py").read_text(encoding="utf-8", errors="replace")
    assert text.count("force_simple_setup") == 1

    node = _method_bodies(APP / "spot_control.py")["register_estop"]
    assert "force_simple_setup" in ast.unparse(node)


def test_forced_lease_take_is_confined_to_the_forced_path():
    """Taking the lease off another operator must never happen as a retry."""
    node = _method_bodies(APP / "spot_control.py")["acquire_lease"]
    source = ast.unparse(node)
    assert "force" in source, "acquire_lease no longer distinguishes forced takes"
    # The bare take() call must sit inside the forced branch.
    assert "if force" in source.replace("\n", " ")


# -- frontend ---------------------------------------------------------------


def test_voice_never_builds_an_endpoint_from_speech():
    """The core voice safety property: a transcript must never become a URL.
    Commands resolve to fixed RobotService calls or nothing happens."""
    dangerous = re.compile(r"""(fetch|call)\s*\(\s*[^)]*\b(transcript|said|speech|heard)\b""", re.I)
    for name in ("voice-control.js", "voice-commands.js", "voice-engine.js"):
        path = FRONTEND / name
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        assert not dangerous.search(text), f"{name} appears to build a request from speech"


def test_voice_commands_only_dispatch_through_robot_service():
    """Each registry entry runs a RobotService method -- never a bare fetch."""
    text = (FRONTEND / "voice-commands.js").read_text(encoding="utf-8", errors="replace")
    runs = re.findall(r"run:\s*function\s*\(svc\)\s*\{\s*return\s+([a-zA-Z.]+)", text)
    assert runs, "no run handlers found -- has the registry format changed?"
    for target in runs:
        assert target.startswith("svc."), f"registry dispatches via {target}, not RobotService"


def test_voice_registry_covers_a_stop():
    """Whatever else changes, an operator must be able to say stop."""
    text = (FRONTEND / "voice-commands.js").read_text(encoding="utf-8", errors="replace")
    assert "EMERGENCY_STOP" in text
    assert '"STOP"' in text or "'STOP'" in text or "intent: \"STOP\"" in text
