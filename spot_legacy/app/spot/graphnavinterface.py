""" SLF interface for Spot. """

import time
import os
import logging
from bosdyn.api import robot_state_pb2
from bosdyn.api.graph_nav import graph_nav_pb2, map_pb2, nav_pb2
from bosdyn.client.exceptions import ResponseError, RpcError
from bosdyn.client.frame_helpers import get_odom_tform_body
from bosdyn.client.graph_nav import GraphNavClient
from bosdyn.client.lease import NoSuchLease
from bosdyn.client.power import (
    PowerClient,
    power_on,
    safe_power_off_motors,
    OverriddenError,
)
from bosdyn.client.robot_command import RobotCommandClient
from bosdyn.client.robot_state import RobotStateClient
from bosdyn.api.spot_cam import audio_pb2
from bosdyn.client.spot_cam.audio import AudioClient

from spot import utils

from spot.exceptions import SLFSpotError, SLFSpotFailure


class GraphNavInterface(object):
    """GraphNav service slf spot interface."""

    def __init__(self, robot, upload_filepath):
        self._robot = robot

        self._sounds = {}

        try:
            # Force trigger timesync.
            self._robot.time_sync.wait_for_sync()

            # Create robot state and command clients.
            self._robot_command_client = self._robot.ensure_client(RobotCommandClient.default_service_name)
            self._robot_state_client = self._robot.ensure_client(RobotStateClient.default_service_name)

            # Create the client for the Graph Nav main service.
            self._graph_nav_client = self._robot.ensure_client(GraphNavClient.default_service_name)

            # Create a power client for the robot.
            self._power_client = self._robot.ensure_client(PowerClient.default_service_name)

            # Boolean indicating the robot's power state.
            power_state = self._robot_state_client.get_robot_state().power_state
            self._started_powered_on = power_state.motor_power_state == power_state.STATE_ON
            self._powered_on = self._started_powered_on

            # Number of attempts to wait before trying to re-power on.
            self._max_attempts_to_wait = 50

            # Store the most recent knowledge of the state of the robot based on rpc calls.
            self._current_graph = None
            self._current_edges = dict()  # maps to_waypoint to list(from_waypoint)
            self._current_waypoint_snapshots = dict()  # maps id to waypoint snapshot
            self._current_edge_snapshots = dict()  # maps id to edge snapshot
            self._current_annotation_name_to_wp_id = dict()
            self._upload_filepath = upload_filepath
        except AttributeError:
            pass
        except RpcError as err:
            logging.error("RpcError")
            raise SLFSpotFailure("Can't connect to Spot.")

    def upload_graph_and_snapshots(self, *args):
        """Upload the graph and snapshots to the robot."""
        print("Loading the graph from disk into local storage...")
        graph_filename = os.path.join(self._upload_filepath, "graph")
        with open(graph_filename, "rb") as graph_file:
            # Load the graph from disk.
            data = graph_file.read()
            self._current_graph = map_pb2.Graph()
            self._current_graph.ParseFromString(data)
            print("Loaded graph has {} waypoints and {} edges".format(len(self._current_graph.waypoints), len(self._current_graph.edges)))
        for waypoint in self._current_graph.waypoints:
            # Load the waypoint snapshots from disk.
            waypoint_filename = os.path.join(self._upload_filepath, "waypoint_snapshots", waypoint.snapshot_id)
            with open(waypoint_filename, "rb") as snapshot_file:
                waypoint_snapshot = map_pb2.WaypointSnapshot()
                waypoint_snapshot.ParseFromString(snapshot_file.read())
                self._current_waypoint_snapshots[waypoint_snapshot.id] = waypoint_snapshot
        for edge in self._current_graph.edges:
            if len(edge.snapshot_id) == 0:
                continue
            # Load the edge snapshots from disk.
            edge_filename = os.path.join(self._upload_filepath, "edge_snapshots", edge.snapshot_id)
            with open(edge_filename, "rb") as snapshot_file:
                edge_snapshot = map_pb2.EdgeSnapshot()
                edge_snapshot.ParseFromString(snapshot_file.read())
                self._current_edge_snapshots[edge_snapshot.id] = edge_snapshot
        # Upload the graph to the robot.
        print("Uploading the graph and snapshots to the robot...")
        true_if_empty = not len(self._current_graph.anchoring.anchors)
        response = self._graph_nav_client.upload_graph(graph=self._current_graph, generate_new_anchoring=true_if_empty)
        # Upload the snapshots to the robot.
        for snapshot_id in response.unknown_waypoint_snapshot_ids:
            waypoint_snapshot = self._current_waypoint_snapshots[snapshot_id]
            self._graph_nav_client.upload_waypoint_snapshot(waypoint_snapshot)
            print("Uploaded {}".format(waypoint_snapshot.id))
        for snapshot_id in response.unknown_edge_snapshot_ids:
            edge_snapshot = self._current_edge_snapshots[snapshot_id]
            self._graph_nav_client.upload_edge_snapshot(edge_snapshot)
            print("Uploaded {}".format(edge_snapshot.id))

    def set_initial_localization_fiducial(self, *args):
        """Trigger localization when near a fiducial."""
        robot_state = self._robot_state_client.get_robot_state()
        current_odom_tform_body = get_odom_tform_body(robot_state.kinematic_state.transforms_snapshot).to_proto()
        # Create an empty instance for initial localization since we are asking it to localize
        # based on the nearest fiducial.
        localization = nav_pb2.Localization()
        self._graph_nav_client.set_localization(
            initial_guess_localization=localization,
            ko_tform_body=current_odom_tform_body,
        )

    def navigate_to(self, *args):
        """Navigate to a specific waypoint."""

        graph = self._graph_nav_client.download_graph()
        self._current_graph = graph

        destination_waypoint = utils.find_unique_waypoint_id(args[0], self._current_graph, self._current_annotation_name_to_wp_id)
        if not destination_waypoint:
            raise SLFSpotFailure("Failed to find the appropriate unique waypoint id for the navigation command.")

        nav_to_cmd_id = None
        # Navigate to the destination waypoint.
        is_finished = False
        while not is_finished:
            # Issue the navigation command about twice a second such that it is easy to terminate the
            # navigation command (with estop or killing the program).
            try:
                nav_to_cmd_id = self._graph_nav_client.navigate_to(destination_waypoint, 1.0, command_id=nav_to_cmd_id)
            except ResponseError as err:
                if err.error_message.find("RobotLostError") != -1:
                    raise SLFSpotError("Localization error. Please move robot manually and start again.") from err
                raise SLFSpotFailure(f"Error while navigating:\n{err}") from err
            except NoSuchLease as err:
                logging.error(f"NoSuchLease while navigating:\n{err}")
                raise SLFSpotFailure("Lost connection to Spot.") from err
            except Exception as exc:
                logging.exception(exc)
                raise SLFSpotFailure("Unknown error.")

            time.sleep(0.3)  # Sleep for half a second to allow for command execution.
            # Poll the robot for feedback to determine if the navigation command is complete. Then sit
            # the robot down once it is finished.
            is_finished = self._check_success(nav_to_cmd_id)

        # Power off the robot if appropriate.
        # if self._powered_on and not self._started_powered_on:
        # Sit the robot down + power off after the navigation command is complete.
        # self.toggle_power(should_power_on=False)

    def play_sound(self, filename: str):
        if filename not in self._sounds:
            with open(f"{filename}", "rb") as fh:
                data = fh.read()

            self._sounds[filename] = audio_pb2.Sound(name=filename)
            self._robot.ensure_client(AudioClient.default_service_name).load_sound(self._sounds[filename], data)
            self._robot.ensure_client(AudioClient.default_service_name).set_volume(100.0)

        self._robot.ensure_client(AudioClient.default_service_name).play_sound(self._sounds[filename], 2.8)

    def mute_sound(self):
        self._robot.ensure_client(AudioClient.default_service_name).set_volume(0.0)

    def toggle_power(self, should_power_on):
        """Power the robot on/off dependent on the current power state."""
        is_powered_on = self.check_is_powered_on()
        if not is_powered_on and should_power_on:
            # Power on the robot up before navigating when it is in a powered-off state.
            try:
                power_on(self._power_client)
            except OverriddenError:
                pass
            motors_on = False
            while not motors_on:
                future = self._robot_state_client.get_robot_state_async()
                state_response = future.result(timeout=10)  # 10 second timeout for waiting for the state response.
                if state_response.power_state.motor_power_state == robot_state_pb2.PowerState.STATE_ON:
                    motors_on = True
                else:
                    # Motors are not yet fully powered on.
                    time.sleep(0.25)
        elif is_powered_on and not should_power_on:
            # Safe power off (robot will sit then power down) when it is in a
            # powered-on state.
            safe_power_off_motors(
                self._robot_command_client,
                self._robot_state_client,
                timeout_sec=40,
                update_frequency=2,
            )
        else:
            # Return the current power state without change.
            return is_powered_on
        # Update the locally stored power state.
        self.check_is_powered_on()
        return self._powered_on

    def check_is_powered_on(self):
        """Determine if the robot is powered on or off."""
        power_state = self._robot_state_client.get_robot_state().power_state
        self._powered_on = power_state.motor_power_state == power_state.STATE_ON
        return self._powered_on

    def _check_success(self, command_id=-1):
        """Use a navigation command id to get feedback from the robot and sit when command succeeds."""
        if command_id == -1:
            # No command, so we have no status to check.
            raise SLFSpotFailure("No command, so we have no status to check.")
        status = self._graph_nav_client.navigation_feedback(command_id)
        if status.status == graph_nav_pb2.NavigationFeedbackResponse.STATUS_REACHED_GOAL:
            # Successfully completed the navigation commands!
            return True
        elif status.status == graph_nav_pb2.NavigationFeedbackResponse.STATUS_LOST:
            raise SLFSpotError('Robot got lost when navigating the route. Click "Stop" and try again.')
        elif status.status == graph_nav_pb2.NavigationFeedbackResponse.STATUS_STUCK:
            raise SLFSpotError('Robot got stuck when navigating the route. Click "Stop" and try again.')
        elif status.status == graph_nav_pb2.NavigationFeedbackResponse.STATUS_ROBOT_IMPAIRED:
            raise SLFSpotError("Robot is impaired.")
        else:
            # Navigation command is not complete yet.
            return False

    def _match_edge(self, current_edges, waypoint1, waypoint2):
        """Find an edge in the graph that is between two waypoint ids."""
        # Return the correct edge id as soon as it's found.
        for edge_to_id in current_edges:
            for edge_from_id in current_edges[edge_to_id]:
                if (waypoint1 == edge_to_id) and (waypoint2 == edge_from_id):
                    # This edge matches the pair of waypoints! Add it the edge list and continue.
                    return map_pb2.Edge.Id(from_waypoint=waypoint2, to_waypoint=waypoint1)
                elif (waypoint2 == edge_to_id) and (waypoint1 == edge_from_id):
                    # This edge matches the pair of waypoints! Add it the edge list and continue.
                    return map_pb2.Edge.Id(from_waypoint=waypoint1, to_waypoint=waypoint2)
        return None
