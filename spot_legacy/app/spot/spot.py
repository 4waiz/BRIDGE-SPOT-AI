import time
import logging
import wave
import os
import bosdyn.client.util
from bosdyn.api import robot_state_pb2
from bosdyn.client.exceptions import ResponseError, ProxyConnectionError, TimedOutError, UnableToConnectToRobotError, UnimplementedError, LeaseUseError, RpcError
from bosdyn.client.robot import UnregisteredServiceNameError
from bosdyn.client.lease import (
    LeaseClient,
    LeaseKeepAlive,
    ResourceAlreadyClaimedError,
    NoSuchLease,
)
from bosdyn.client.estop import EstopClient, EndpointUnknownError, MotorsOnError
from bosdyn.client.graph_nav import RobotNotLocalizedToRouteError
from bosdyn.client.power import FaultedError, CommandTimedOutError, EstoppedError
from bosdyn.client import spot_cam, robot_command
from bosdyn.client.robot_command import blocking_stand, RobotCommandClient, CommandFailedError
from bosdyn.client.robot_state import RobotStateClient
from bosdyn.client.docking import (
    blocking_dock_robot,
    # blocking_undock,
    get_dock_id,
    blocking_go_to_prep_pose,
)

from spot.estop import EstopNoGui
from spot.exceptions import SLFSpotError, SLFSpotFailure
from spot.graphnavinterface import GraphNavInterface


class Spot:
    """This class contains all Bridge Spot AI spot functions."""

    ip = ""
    upload_filepath = ""
    robot = None
    lease_keep_alive = None
    estop_keep_alive = None
    map_code = None

    def __init__(self, ip: str, upload_filepath_base: str) -> None:
        self.ip = ip
        with open("../data/map_code.txt", "r", encoding="utf-8") as f:
            self.map_code = f.read()
        self.upload_filepath = os.path.join(upload_filepath_base, self.map_code, "downloaded_graph")
        self.authenticate()

    def obtain_cut_motor_power_authority(self):
        """Obtain estop keep alive."""

        if self.estop_keep_alive:
            logging.info("Estop has been acquired already. Returning...")
            # if self.estop_keep_alive.is_stopped():
            #     self.estop_keep_alive.allow()

            return

        try:
            estop_client = self.robot.ensure_client(EstopClient.default_service_name)
            self.estop_keep_alive = EstopNoGui(estop_client, 3, "Bridge Spot AI E-Stop")
        except (
            ProxyConnectionError,
            TimedOutError,
            UnableToConnectToRobotError,
            UnimplementedError,
            AttributeError,  # NOTE: this can be considered as failure as well -> check it out
            CommandTimedOutError,
        ) as err:
            raise SLFSpotError("Spot could not be reached. Make sure it is powered on and connected to the WIFI.") from err
        except UnregisteredServiceNameError as err:
            raise SLFSpotError("Spot is still booting. Please try again.") from err
        except MotorsOnError as err:
            raise SLFSpotError("Wait for other services to disconnect before connecting to Spot. ") from err

    def obtain_lease(self):
        """Obtain Spot lease, toggle power, upload map and stand up."""

        if self.lease_keep_alive and self.lease_keep_alive.is_alive():
            return

        try:
            lease_client = self.robot.ensure_client(LeaseClient.default_service_name)
            # Hijack lease
            lease_client.take()
        except (
            ProxyConnectionError,
            TimedOutError,
            UnableToConnectToRobotError,
            UnimplementedError,
            AttributeError,  # NOTE: this can be considered as failure as well -> check it out
            CommandTimedOutError,
        ) as err:
            raise SLFSpotError("Spot could not be reached. Make sure it is powered on and connected to the WIFI.") from err

        try:
            state_client = self.robot.ensure_client(RobotStateClient.default_service_name)
            if state_client.get_robot_state().power_state.motor_power_state == robot_state_pb2.PowerState.STATE_ON:
                GraphNavInterface(robot=self.robot, upload_filepath=self.upload_filepath).toggle_power(should_power_on=False)
                time.sleep(3)
        except (
            ProxyConnectionError,
            TimedOutError,
            UnableToConnectToRobotError,
            UnimplementedError,
            AttributeError,  # NOTE: this can be considered as failure as well -> check it out
            CommandTimedOutError,
        ) as err:
            raise SLFSpotError("Spot could not be reached. Make sure it is powered on and connected to the WIFI.") from err
        except NoSuchLease as err:
            raise SLFSpotError("Spot is currently claimed by another controller.") from err

        try:
            self.lease_keep_alive = LeaseKeepAlive(lease_client, must_acquire=True, return_at_exit=True)
        except ResourceAlreadyClaimedError as exc:
            raise SLFSpotError("Spot is already claimed by another controller.") from exc
        except (
            ProxyConnectionError,
            TimedOutError,
            UnableToConnectToRobotError,
            UnimplementedError,
            AttributeError,  # NOTE: this can be considered as failure as well -> check it out
            CommandTimedOutError,
        ) as err:
            raise SLFSpotError("Spot could not be reached. Make sure it is powered on and connected to the WIFI.") from err

    def dock(self, dock_id: int):
        command_client = self.robot.ensure_client(robot_command.RobotCommandClient.default_service_name)

        try:
            # Stand before trying to dock.
            robot_command.blocking_stand(command_client)
            blocking_dock_robot(self.robot, dock_id)
            logging.info("Docking Success")
        except ResponseError as err:
            if err.error_message.find("STATUS_ERROR_DOCK_NOT_FOUND") != -1:
                raise SLFSpotError("Spot can't find docking station. Ensure the dock's fiducial is in sight.") from err
            raise SLFSpotFailure(err.error_message) from err
        except NoSuchLease as err:
            logging.error("NoSuchLease while navigating:\n%s", err)
            raise SLFSpotFailure("Lost connection to Spot.") from err
        except CommandFailedError as err:
            raise SLFSpotFailure("Failed to dock Spot. Try again.") from err

    def undock(self):
        try:
            GraphNavInterface(robot=self.robot, upload_filepath=self.upload_filepath).toggle_power(should_power_on=True)
            time.sleep(3)
        except (
            ProxyConnectionError,
            TimedOutError,
            UnableToConnectToRobotError,
            UnimplementedError,
            AttributeError,  # NOTE: this can be considered as failure as well -> check it out
            CommandTimedOutError,
        ) as err:
            raise SLFSpotError("Spot could not be reached. Make sure it is powered on and connected to the WIFI.") from err
        except NoSuchLease as err:
            raise SLFSpotFailure(err) from err

        dock_id = get_dock_id(self.robot)
        if dock_id is not None:
            logging.info("Docked at %s", dock_id)
            # blocking_undock(self.robot)
            blocking_go_to_prep_pose(self.robot, dock_id)
            logging.info("Undocking Success")
        else:
            logging.info("Robot does not seem to be docked; doing nothing")

    def is_docked(self):
        dock_id = get_dock_id(self.robot)
        return dock_id is not None

    def localize(self):
        try:
            localize_nav = GraphNavInterface(robot=self.robot, upload_filepath=self.upload_filepath)
            if not localize_nav.toggle_power(should_power_on=True):
                raise SLFSpotError("Failed to power on the robot.")
        except (
            ProxyConnectionError,
            TimedOutError,
            UnableToConnectToRobotError,
            UnimplementedError,
            AttributeError,  # NOTE: this can be considered as failure as well -> check it out
            CommandTimedOutError,
        ) as err:
            raise SLFSpotError("Spot could not be reached. Make sure it is powered on and connected to the WIFI.") from err
        except FaultedError as err:
            raise SLFSpotError("Spot ran into an error powering on. Check battery...") from err
        except LeaseUseError as err:
            raise SLFSpotError("There was an issue acquiring the Spot's lease. Please try again or check the handheld.") from err
        except EstoppedError as err:
            raise SLFSpotError('Spot is currently estopped. Press "Allow" to release estop.') from err

        try:
            GraphNavInterface(robot=self.robot, upload_filepath=self.upload_filepath).toggle_power(should_power_on=True)
            command_client = self.robot.ensure_client(RobotCommandClient.default_service_name)
            blocking_stand(command_client, timeout_sec=10)
        except (
            ProxyConnectionError,
            TimedOutError,
            UnableToConnectToRobotError,
            UnimplementedError,
            AttributeError,  # NOTE: this can be considered as failure as well -> check it out
            CommandTimedOutError,
            CommandFailedError,
        ) as err:
            raise SLFSpotError("Spot could not be reached. Make sure it is powered on and connected to the WIFI.") from err
        except LeaseUseError as err:
            raise SLFSpotError("There was an issue acquiring the Spot's lease. Please try again or check the handheld.") from err

        try:
            localize_nav.upload_graph_and_snapshots()
            localize_nav.set_initial_localization_fiducial()
        except RobotNotLocalizedToRouteError as err:
            raise SLFSpotError("Spot can't be localized. Ensure fiducial is in sight.") from err
        except ResponseError as resp_err:
            if resp_err.error_message.find("STATUS_NO_MATCHING_FIDUCIAL") != -1:
                raise SLFSpotError("Spot can't be localized. Ensure fiducial is in sight.") from resp_err
            raise SLFSpotFailure(resp_err.error_message) from resp_err
        except (
            ProxyConnectionError,
            TimedOutError,
            UnableToConnectToRobotError,
            UnimplementedError,
            AttributeError,  # NOTE: this can be considered as failure as well -> check it out
            CommandTimedOutError,
        ) as err:
            raise SLFSpotError("Spot could not be reached. Make sure it is powered on and connected to the WIFI.") from err
        except FileNotFoundError as err:
            raise SLFSpotFailure(f"Spot could not load its map:\n{err}") from err

    def navigate_to(self, dest: str):
        """Navigate spot to dest."""

        # self.obtain_cut_motor_power_authority()
        self.obtain_lease()
        self.localize()

        try:
            interface = GraphNavInterface(robot=self.robot, upload_filepath=self.upload_filepath)
            interface.navigate_to(dest)
        except (
            ProxyConnectionError,
            TimedOutError,
            UnableToConnectToRobotError,
            UnimplementedError,
            AttributeError,  # NOTE: this can be considered as failure as well -> check it out
            CommandTimedOutError,
        ) as err:
            raise SLFSpotError("Spot could not be reached. Make sure it is powered on and connected to the WIFI.") from err
        except RobotNotLocalizedToRouteError as err:
            raise SLFSpotError("Spot can't be localized. Ensure fiducial is in sight.") from err
        except RpcError as err:
            logging.error("RpcError")
            raise SLFSpotFailure("Can't connect to Spot.")

    def play_sound(self, filename: str):
        # get length of audio file in seconds
        with wave.open(f=filename, mode="rb") as wav:
            duration_in_sec = wav.getnframes() / wav.getframerate()

        try:
            GraphNavInterface(robot=self.robot, upload_filepath=self.upload_filepath).play_sound(filename=filename)
            # NOTE: +2 seconds because of slow connection in LIF -> can be changed if neccessary
            time.sleep(duration_in_sec + 1)
        except (
            ProxyConnectionError,
            TimedOutError,
            UnableToConnectToRobotError,
            UnimplementedError,
            AttributeError,  # NOTE: this can be considered as failure as well -> check it out
            CommandTimedOutError,
        ) as err:
            raise SLFSpotError("Spot could not be reached. Make sure it is powered on and connected to the WIFI.") from err

    def estop(self):
        """Stop spot."""

        try:
            self.estop_keep_alive.stop()
        except (
            ProxyConnectionError,
            TimedOutError,
            UnableToConnectToRobotError,
            UnimplementedError,
            CommandTimedOutError,
        ) as err:
            raise SLFSpotError("Spot could not be reached. Make sure it is powered on and connected to the WIFI.") from err
        except AttributeError:  # NOTE: this can be considered as failure as well -> check it out
            pass

    def estop_allow(self):
        """Allow estopped Spot."""

        try:
            if self.estop_keep_alive.is_stopped():
                self.estop_keep_alive.allow()
        except (
            ProxyConnectionError,
            TimedOutError,
            UnableToConnectToRobotError,
            UnimplementedError,
            CommandTimedOutError,
        ) as err:
            raise SLFSpotError("Spot could not be reached. Make sure it is powered on and connected to the WIFI.") from err
        except AttributeError:  # NOTE: this can be considered as failure as well -> check it out
            pass

    def startup(self):
        try:
            # self.obtain_cut_motor_power_authority()
            self.obtain_lease()
            # TODO: insert self.undock() here, if Spot was docked -> how to determine, if Spot is docked?
            # bosdyn example provides info via function param
            self.localize()
        except (SLFSpotError, SLFSpotFailure) as err:
            self.release_lease()
            raise err

    def shutdown(self):
        """Wrap turning robot off and releasing lease in a single function."""

        # TODO: dock robot using self.dock(520)
        # determine, robot needs to be docked
        # self.cut_motor_power()
        self.release_lease()
        # self.release_estop()

    def authenticate(self):
        """Creates robot object."""

        sdk = bosdyn.client.create_standard_sdk("BridgeSpotAIClient")
        spot_cam.register_all_service_clients(sdk)
        self.robot = sdk.create_robot(self.ip)

        try:
            # bosdyn.client.util.authenticate(self.robot, _auth_cred)
            bosdyn.client.util.authenticate(robot=self.robot)
        except (
            ProxyConnectionError,
            TimedOutError,
            UnableToConnectToRobotError,
            UnimplementedError,
            AttributeError,  # NOTE: this can be considered as failure as well -> check it out
            CommandTimedOutError,
        ) as err:
            raise SLFSpotError("Spot could not be reached. Make sure it is powered on and connected to the WIFI.") from err

        self.robot.time_sync.wait_for_sync(timeout_sec=10.0)

    # NOTE: this is only needed when not using env vars for providing credentials
    # def _auth_cred(self):
    #     return "slf", "Pr0tected#2021$"

    def cut_motor_power(self):
        """Turn off spot and sit down."""

        try:
            self.estop_keep_alive.settle_then_cut()
        except (
            ProxyConnectionError,
            TimedOutError,
            UnableToConnectToRobotError,
            UnimplementedError,
            CommandTimedOutError,
        ) as err:
            raise SLFSpotError("Spot could not be reached. Make sure it is powered on and connected to the WIFI.") from err
        except EndpointUnknownError as err:
            raise SLFSpotError("Control over spot has not been acquired yet. Wait until the robot has stood up.") from err
        except AttributeError:  # NOTE: this can be considered as failure as well -> check it out
            pass

    def release_estop(self):
        """Release estop lease."""

        if not self.estop_keep_alive:
            return

        # if self.estop_keep_alive.is_stopped():
        #     self.estop_keep_alive.allow()

        try:
            self.estop_keep_alive.estop_keep_alive.shutdown()
            self.estop_keep_alive = None
        except (
            ProxyConnectionError,
            TimedOutError,
            UnableToConnectToRobotError,
            UnimplementedError,
            CommandTimedOutError,
        ) as err:
            raise SLFSpotError("Spot could not be reached. Make sure it is powered on and connected to the WIFI.") from err
        except EndpointUnknownError as err:
            raise SLFSpotError("Control over spot has not been acquired yet. Wait until the robot has stood up.") from err
        except AttributeError:  # NOTE: this can be considered as failure as well -> check it out
            pass

    def release_lease(self):
        """Release robot lease."""

        if not self.lease_keep_alive:
            return

        try:
            state_client = self.robot.ensure_client(RobotStateClient.default_service_name)
            if state_client.get_robot_state().power_state.motor_power_state == robot_state_pb2.PowerState.STATE_ON:
                GraphNavInterface(robot=self.robot, upload_filepath=self.upload_filepath).toggle_power(should_power_on=False)
                time.sleep(3)
        except (
            ProxyConnectionError,
            TimedOutError,
            UnableToConnectToRobotError,
            UnimplementedError,
            AttributeError,  # NOTE: this can be considered as failure as well -> check it out
            CommandTimedOutError,
        ) as err:
            raise SLFSpotError("Spot could not be reached. Make sure it is powered on and connected to the WIFI.") from err
        except (NoSuchLease, LeaseUseError) as err:
            raise SLFSpotFailure(err) from err

        try:
            self.lease_keep_alive.shutdown()
            self.lease_keep_alive = None
        except (
            ProxyConnectionError,
            TimedOutError,
            UnableToConnectToRobotError,
            UnimplementedError,
            CommandTimedOutError,
        ) as err:
            raise SLFSpotError("Spot could not be reached. Make sure it is powered on and connected to the WIFI.") from err
        except EndpointUnknownError as err:
            raise SLFSpotError("Control over spot has not been acquired yet. Wait until the robot has stood up.") from err
        except AttributeError:  # NOTE: this can be considered as failure as well -> check it out
            pass

# Changes made by Awaiz Ahmed
