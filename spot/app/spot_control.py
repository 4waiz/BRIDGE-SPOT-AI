"""Live control layer for BRIDGE SPOT.

Wraps the Boston Dynamics client library behind a single stateful controller so
the FastAPI app can drive the robot over HTTP. Everything here talks to real
hardware -- see the safety notes before changing it.

Safety model
------------
Motion is gated behind three things, in order, and none of them are optional:

  1. E-stop registration. `register_estop()` opens a software E-stop endpoint and
     starts a heartbeat. If this process dies, the heartbeat stops and the robot
     cuts motor power on its own. This is the backstop for "the server crashed
     mid-drive".
  2. Lease ownership. `acquire_lease()` takes the body lease. Without it the
     robot rejects commands, which is what stops two operators fighting over it.
  3. Command expiry. Every velocity command carries `end_time_secs`. If the UI
     stops sending -- tab closed, wifi dropped, joystick released -- the robot
     stops moving after SPOT_CMD_DURATION rather than running on.

Speeds are clamped server-side in `move()`. The UI cannot exceed the configured
caps no matter what it posts.

None of this replaces the hardware E-stop on the tablet. The tablet controller
should stay in reach whenever this module is driving.
"""

import logging
import os
import threading
import time

import dotenv

dotenv.load_dotenv("../config.env")

import bosdyn.client
import bosdyn.client.util
from bosdyn.api import image_pb2
from bosdyn.api.docking import docking_pb2
from bosdyn.client.docking import DockingClient, blocking_dock_robot, blocking_undock, get_dock_id
from bosdyn.client.estop import EstopClient, EstopEndpoint, EstopKeepAlive
from bosdyn.client.image import ImageClient
from bosdyn.client.lease import LeaseClient, LeaseKeepAlive, ResourceAlreadyClaimedError
from bosdyn.client.power import PowerClient
from bosdyn.client.robot_command import RobotCommandBuilder, RobotCommandClient
from bosdyn.client.robot_state import RobotStateClient

import missions as mission_service
import spot_choreography
from bosdyn.client.autowalk import AutowalkClient
from bosdyn.client.graph_nav import GraphNavClient
from bosdyn.mission.client import MissionClient

SPOT_IP = os.getenv("SPOT_IP", "192.168.33.137")
DOCK_ID = int(os.getenv("SPOT_DOCK_ID", "520"))

MAX_LINEAR = float(os.getenv("SPOT_MAX_LINEAR_SPEED", "0.6"))
MAX_ANGULAR = float(os.getenv("SPOT_MAX_ANGULAR_SPEED", "0.8"))
CMD_DURATION = float(os.getenv("SPOT_CMD_DURATION", "0.6"))

# Seconds the robot waits for an E-stop heartbeat before cutting power. Kept
# generous enough to survive a slow HTTP round trip but short enough to matter.
ESTOP_TIMEOUT = 9.0
CLIENT_NAME = "BridgeSpotControl"

# The Spot CAM payload runs its own ImageService alongside the body one, so it
# needs a separately registered client keyed on this service name.
SPOT_CAM_IMAGE_SERVICE = "spot-cam-image"

# view name -> (service, source name, display rotation in degrees)
#
# The body fisheyes are mounted rotated, so the UI has to spin them upright.
# Spot CAM sources come off the payload already the right way up.
CAMERAS = {
    # Body cameras (640x480 greyscale fisheye)
    "frontleft": ("body", "frontleft_fisheye_image", -90),
    "frontright": ("body", "frontright_fisheye_image", -90),
    "left": ("body", "left_fisheye_image", 0),
    "right": ("body", "right_fisheye_image", 180),
    "back": ("body", "back_fisheye_image", 0),
    # Spot CAM payload
    "cam-ptz": ("spotcam", "ptz", 0),               # 1920x1080 colour PTZ
    "cam-stream": ("spotcam", "stream", 0),         # 1280x720 composited stream
    "cam-ir": ("spotcam", "ir", 0),                 # 640x512 thermal
    "cam-ir-overlay": ("spotcam", "ptz-ir-overlay", 0),  # thermal over visible
    "cam-pano": ("spotcam", "pano", 0),             # 9600x1080 panoramic, large
}


class SpotControlError(RuntimeError):
    """Raised for any expected, reportable control failure."""


class LeaseHeldByOtherError(SpotControlError):
    """The lease belongs to someone else -- usually the tablet.

    Distinct from the generic error so the API can tell the UI to offer a
    forced take rather than just reporting a dead end.
    """


# The docking service reports failures as numeric proto statuses. Surfacing
# those raw ("Code: 6 (STATUS_ERROR_NOT_DOCKED)") tells an operator nothing, so
# translate the ones that are actually actionable.
DOCKING_ERRORS = {
    docking_pb2.DockingCommandResponse.STATUS_ERROR_NOT_DOCKED:
        "Spot is not on the dock, so there is nothing to undock from.",
    docking_pb2.DockingCommandResponse.STATUS_ERROR_DOCK_NOT_FOUND:
        "Spot cannot see the dock. Walk it to within a couple of metres with the "
        "dock fiducial in view of the front cameras, then try again.",
    docking_pb2.DockingCommandResponse.STATUS_ERROR_LEASE:
        "Another operator holds the lease, so the dock command was refused.",
    docking_pb2.DockingCommandResponse.STATUS_ERROR_GRIPPER_HOLDING_ITEM:
        "Spot is holding something in its gripper. Release it before docking.",
    docking_pb2.DockingCommandResponse.STATUS_ERROR_NOT_AVAILABLE:
        "The dock is not available. Check it has power and no other robot is on it.",
    docking_pb2.DockingCommandResponse.STATUS_ERROR_SYSTEM:
        "The docking system reported a fault. Check the tablet for details.",
}


def _docking_message(exc, fallback):
    """Turn a docking ResponseError into something worth showing a human."""
    status = getattr(getattr(exc, "response", None), "status", None)
    if status in DOCKING_ERRORS:
        return DOCKING_ERRORS[status]
    return f"{fallback}: {exc}"


def _clamp(value, limit):
    try:
        value = float(value)
    except (TypeError, ValueError):
        return 0.0
    if value != value:  # NaN
        return 0.0
    return max(-limit, min(limit, value))


class SpotController(spot_choreography.ChoreographyMixin, mission_service.MissionMixin):
    """Single owner of the robot connection, lease and E-stop.

    One instance per process. Every public method takes `_lock`, because the
    SDK's lease and E-stop objects are not safe to drive from several request
    handlers at once.
    """

    def __init__(self):
        self._lock = threading.RLock()
        self._robot = None
        self._clients = {}
        self._estop_endpoint = None
        self._estop_keepalive = None
        self._lease_keepalive = None
        self._last_error = None
        # Dance and mission state, so status can be reported before connecting.
        self._init_choreography()
        self._init_missions()

    # -- connection ---------------------------------------------------------

    @property
    def is_connected(self):
        return self._robot is not None

    def connect(self):
        """Authenticate and build the service clients. Safe to call repeatedly."""
        with self._lock:
            if self._robot is not None:
                return self.describe()

            username = os.getenv("BOSDYN_CLIENT_USERNAME", "").strip()
            password = os.getenv("BOSDYN_CLIENT_PASSWORD", "").strip()
            if not username or not password:
                raise SpotControlError(
                    "Robot credentials are not configured. Set BOSDYN_CLIENT_USERNAME "
                    "and BOSDYN_CLIENT_PASSWORD in spot/config.env."
                )

            # MissionClient is not part of the standard client set, so it has to
            # be declared when the SDK is created rather than registered later.
            sdk = bosdyn.client.create_standard_sdk(CLIENT_NAME, [MissionClient])
            # Bind a second ImageClient to the Spot CAM payload's own image
            # service. Without this only the five body fisheyes are reachable.
            sdk.register_service_client(ImageClient, service_name=SPOT_CAM_IMAGE_SERVICE)
            robot = sdk.create_robot(SPOT_IP)
            try:
                robot.authenticate(username, password)
            except Exception as exc:
                raise SpotControlError(f"Authentication failed for {SPOT_IP}: {exc}") from exc

            # Robot commands are rejected without a synced clock.
            robot.time_sync.wait_for_sync()

            self._robot = robot
            self._clients = {
                "state": robot.ensure_client(RobotStateClient.default_service_name),
                "command": robot.ensure_client(RobotCommandClient.default_service_name),
                "lease": robot.ensure_client(LeaseClient.default_service_name),
                "estop": robot.ensure_client(EstopClient.default_service_name),
                "power": robot.ensure_client(PowerClient.default_service_name),
                "image": robot.ensure_client(ImageClient.default_service_name),
                "docking": robot.ensure_client(DockingClient.default_service_name),
            }

            # Spot CAM is a payload and may simply not be fitted. Treat it as
            # optional so a robot without one still gets body cameras.
            try:
                self._clients["spotcam_image"] = robot.ensure_client(SPOT_CAM_IMAGE_SERVICE)
                logging.info("Spot CAM image service available")
            except Exception as exc:
                self._clients["spotcam_image"] = None
                logging.warning("Spot CAM not available: %s", exc)

            logging.info("Connected to Spot at %s as %s", SPOT_IP, username)
            return self.describe()

    def describe(self):
        rid = self._robot.get_id()
        version = rid.software_release.version
        return {
            "nickname": rid.nickname,
            "serial": rid.serial_number,
            "software": f"{version.major_version}.{version.minor_version}.{version.patch_level}",
            "ip": SPOT_IP,
        }

    def disconnect(self):
        """Give everything back and drop the connection."""
        with self._lock:
            self.return_lease()
            self.release_estop()
            self._robot = None
            self._clients = {}

    def _require(self):
        if self._robot is None:
            raise SpotControlError("Not connected to the robot. Connect first.")
        return self._robot

    # Mission services are created on first use rather than at connect: they are
    # only needed for Autowalk, and a robot without them should still connect.
    def _lazy_client(self, key, service_name):
        self._require()
        client = self._clients.get(key)
        if client is None:
            try:
                client = self._robot.ensure_client(service_name)
            except Exception as exc:
                raise SpotControlError(
                    f"The {service_name} service is unavailable on this robot: {exc}"
                ) from exc
            self._clients[key] = client
        return client

    def _graph_nav_client(self):
        return self._lazy_client("graph_nav", GraphNavClient.default_service_name)

    def _autowalk_client(self):
        return self._lazy_client("autowalk", AutowalkClient.default_service_name)

    def _mission_client(self):
        return self._lazy_client("mission", MissionClient.default_service_name)

    # -- E-stop -------------------------------------------------------------

    def register_estop(self):
        """Open a software E-stop endpoint and start its heartbeat."""
        with self._lock:
            self._require()
            if self._estop_keepalive is not None:
                return {"estop": "registered"}

            client = self._clients["estop"]
            if client.get_status().stop_level_details and client.get_status().endpoints:
                logging.info("Existing E-stop endpoints present; registering alongside them.")

            endpoint = EstopEndpoint(client, CLIENT_NAME, ESTOP_TIMEOUT)
            # Claims the whole E-stop config for this endpoint. Any other
            # software endpoint (a stale session, another script) is displaced.
            endpoint.force_simple_setup()
            self._estop_endpoint = endpoint
            self._estop_keepalive = EstopKeepAlive(endpoint)
            logging.info("E-stop endpoint registered (timeout %.1fs)", ESTOP_TIMEOUT)
            return {"estop": "registered"}

    def emergency_stop(self):
        """Cut motor power now. The robot will sit down hard."""
        with self._lock:
            if self._estop_keepalive is None:
                raise SpotControlError("No E-stop endpoint registered.")
            self._estop_keepalive.stop()
            logging.warning("EMERGENCY STOP triggered")
            return {"estop": "engaged"}

    def clear_estop(self):
        """Release a triggered E-stop so the robot can be powered again."""
        with self._lock:
            if self._estop_keepalive is None:
                raise SpotControlError("No E-stop endpoint registered.")
            self._estop_keepalive.allow()
            logging.info("E-stop cleared")
            return {"estop": "cleared"}

    def release_estop(self):
        """Tear the endpoint down entirely."""
        with self._lock:
            if self._estop_keepalive is not None:
                try:
                    self._estop_keepalive.shutdown()
                except Exception as exc:
                    logging.warning("E-stop shutdown failed: %s", exc)
            self._estop_keepalive = None
            self._estop_endpoint = None
            return {"estop": "released"}

    # -- lease --------------------------------------------------------------

    def acquire_lease(self, force=False):
        """Take the body lease.

        `force=True` uses the lease service's Take rather than Acquire, which
        wrests the lease off whoever currently holds it. That is almost always
        the tablet, and the tablet operator loses control the moment it lands --
        so the caller is expected to have confirmed with a human first. The API
        layer keeps this on a separate endpoint for exactly that reason.
        """
        with self._lock:
            self._require()
            if self._lease_keepalive is not None:
                return {"lease": "held"}

            client = self._clients["lease"]
            try:
                if force:
                    # Take() displaces the current holder, then the keepalive
                    # adopts the lease already sitting in the wallet.
                    client.take()
                    self._lease_keepalive = LeaseKeepAlive(client, return_at_exit=True)
                    logging.warning("Body lease FORCIBLY taken from the previous holder")
                    return {"lease": "held", "forced": True}

                self._lease_keepalive = LeaseKeepAlive(
                    client, must_acquire=True, return_at_exit=True
                )
            except ResourceAlreadyClaimedError as exc:
                raise LeaseHeldByOtherError(
                    "The body lease is held by another operator, usually the tablet. "
                    "Take it only if you can see the robot and know nobody else is "
                    "driving it."
                ) from exc
            except Exception as exc:
                raise SpotControlError(f"Could not take the body lease: {exc}") from exc

            logging.info("Body lease acquired")
            return {"lease": "held", "forced": False}

    def return_lease(self):
        with self._lock:
            if self._lease_keepalive is not None:
                try:
                    self._lease_keepalive.shutdown()
                except Exception as exc:
                    logging.warning("Lease shutdown failed: %s", exc)
            self._lease_keepalive = None
            return {"lease": "released"}

    def _require_control(self):
        """Guard for anything that physically moves the robot."""
        self._require()
        if self._estop_keepalive is None:
            raise SpotControlError("Register the E-stop before commanding the robot.")
        if self._lease_keepalive is None:
            raise SpotControlError("Acquire the lease before commanding the robot.")

    # -- power and posture --------------------------------------------------

    def power_on(self):
        with self._lock:
            self._require_control()
            robot = self._robot
            if robot.is_powered_on():
                return {"power": "on"}
            robot.power_on(timeout_sec=20)
            if not robot.is_powered_on():
                raise SpotControlError("Motor power did not come up.")
            logging.info("Motors powered on")
            return {"power": "on"}

    def power_off(self):
        with self._lock:
            self._require_control()
            # safe_power_off sits the robot down before cutting power.
            self._robot.power_off(cut_immediately=False, timeout_sec=20)
            logging.info("Motors powered off")
            return {"power": "off"}

    def _command(self, proto, end_time_secs=None, description=""):
        self._require_control()
        try:
            self._clients["command"].robot_command(command=proto, end_time_secs=end_time_secs)
        except Exception as exc:
            raise SpotControlError(f"Command '{description}' rejected: {exc}") from exc
        return {"command": description or "ok"}

    def stand(self):
        with self._lock:
            return self._command(RobotCommandBuilder.synchro_stand_command(), description="stand")

    def sit(self):
        with self._lock:
            return self._command(RobotCommandBuilder.synchro_sit_command(), description="sit")

    def selfright(self):
        with self._lock:
            return self._command(RobotCommandBuilder.selfright_command(), description="selfright")

    def stop(self):
        """Halt motion but keep power and lease."""
        with self._lock:
            return self._command(RobotCommandBuilder.stop_command(), description="stop")

    # -- drive --------------------------------------------------------------

    def move(self, v_x, v_y, v_rot):
        """Drive at a velocity for one command window.

        Values are clamped to the configured caps, and the command carries an
        expiry so the robot stops on its own if the UI goes quiet.
        """
        with self._lock:
            v_x = _clamp(v_x, MAX_LINEAR)
            v_y = _clamp(v_y, MAX_LINEAR)
            v_rot = _clamp(v_rot, MAX_ANGULAR)
            proto = RobotCommandBuilder.synchro_velocity_command(v_x=v_x, v_y=v_y, v_rot=v_rot)
            self._command(proto, end_time_secs=time.time() + CMD_DURATION, description="move")
            return {"v_x": v_x, "v_y": v_y, "v_rot": v_rot, "expires_in": CMD_DURATION}

    # -- docking ------------------------------------------------------------

    def _docked_status(self):
        """Current DockedStatus, or None when the service cannot be reached."""
        try:
            return self._clients["docking"].get_docking_state().status
        except Exception as exc:
            logging.debug("Could not read docking state: %s", exc)
            return None

    def dock(self, dock_id=None):
        """Drive onto the charging dock. Blocking, takes a while."""
        with self._lock:
            self._require_control()
            target = int(dock_id) if dock_id is not None else DOCK_ID
            if not self._robot.is_powered_on():
                raise SpotControlError("Power the motors on before docking.")

            # Check first rather than letting the service reject it: the answer
            # is instant and the message is far clearer than the proto status.
            if self._docked_status() == docking_pb2.DockState.DOCK_STATUS_DOCKED:
                raise SpotControlError("Spot is already docked.")

            try:
                blocking_dock_robot(self._robot, target)
            except Exception as exc:
                raise SpotControlError(_docking_message(exc, "Docking failed")) from exc
            logging.info("Docked at %s", target)
            return {"docked": True, "dock_id": target}

    def undock(self):
        """Walk off the dock. Blocking."""
        with self._lock:
            self._require_control()

            status = self._docked_status()
            if status == docking_pb2.DockState.DOCK_STATUS_UNDOCKED:
                raise SpotControlError(
                    "Spot is not on the dock, so there is nothing to undock from."
                )

            try:
                blocking_undock(self._robot)
            except Exception as exc:
                raise SpotControlError(_docking_message(exc, "Undocking failed")) from exc
            logging.info("Undocked")
            return {"docked": False}

    # -- telemetry ----------------------------------------------------------

    def get_state(self):
        """Read-only snapshot. Needs no lease and no E-stop, so the UI can poll
        it before the operator has taken control."""
        with self._lock:
            self._require()
            state = self._clients["state"].get_robot_state()

            battery = {}
            if state.battery_states:
                bat = state.battery_states[0]
                battery = {
                    "percentage": round(bat.charge_percentage.value, 1)
                    if bat.HasField("charge_percentage") else None,
                    "status": bat.Status.Name(bat.status),
                    "temperature": round(max(bat.temperatures), 1) if bat.temperatures else None,
                }

            power_state = state.power_state
            estop_levels = [
                {"name": e.name, "state": e.State.Name(e.state)} for e in state.estop_states
            ]
            estop_ok = all(e["state"] == "STATE_NOT_ESTOPPED" for e in estop_levels) if estop_levels else False

            comms = []
            for c in state.comms_states:
                if c.HasField("wifi_state"):
                    wifi = c.wifi_state
                    comms.append(
                        {
                            "mode": wifi.Mode.Name(wifi.current_mode),
                            "essid": wifi.essid,
                        }
                    )

            try:
                ds = self._clients["docking"].get_docking_state()
                docking = {
                    "status": docking_pb2.DockState.DockedStatus.Name(ds.status),
                    "dock_id": ds.dock_id or None,
                }
            except Exception as exc:
                logging.debug("Docking state unavailable: %s", exc)
                docking = {"status": "DOCK_STATUS_UNKNOWN", "dock_id": None}

            faults = [f.name for f in state.system_fault_state.faults] if state.system_fault_state else []

            return {
                "connected": True,
                "battery": battery,
                "power": power_state.MotorPowerState.Name(power_state.motor_power_state),
                "powered_on": self._robot.is_powered_on(),
                "estop": {
                    "levels": estop_levels,
                    "clear": estop_ok,
                    "registered": self._estop_keepalive is not None,
                },
                "lease_held": self._lease_keepalive is not None,
                "comms": comms,
                "docking": docking,
                "faults": faults,
                "limits": {
                    "max_linear": MAX_LINEAR,
                    "max_angular": MAX_ANGULAR,
                    "cmd_duration": CMD_DURATION,
                },
            }

    def list_cameras(self):
        """Camera views this robot can actually serve right now."""
        with self._lock:
            has_spotcam = bool(self._clients.get("spotcam_image"))
            return [
                {"view": view, "source": source, "payload": service == "spotcam"}
                for view, (service, source, _) in CAMERAS.items()
                if service == "body" or has_spotcam
            ]

    def get_image(self, view="frontleft"):
        """Return (jpeg_bytes, rotation_degrees) for one camera view."""
        with self._lock:
            self._require()
            entry = CAMERAS.get(view)
            if entry is None:
                raise SpotControlError(
                    f"Unknown camera '{view}'. Options: {', '.join(CAMERAS)}"
                )
            service, source, rotation = entry

            if service == "spotcam":
                client = self._clients.get("spotcam_image")
                if client is None:
                    raise SpotControlError(
                        "Spot CAM is not available on this robot. Use a body camera."
                    )
            else:
                client = self._clients["image"]

            responses = client.get_image_from_sources([source])
            if not responses:
                raise SpotControlError(f"No image returned for {source}.")
            image = responses[0].shot.image
            if image.format != image_pb2.Image.FORMAT_JPEG:
                raise SpotControlError(
                    f"Unexpected image format for {source}: "
                    f"{image_pb2.Image.Format.Name(image.format)}."
                )
            return image.data, rotation


# Process-wide singleton used by the API layer.
controller = SpotController()
