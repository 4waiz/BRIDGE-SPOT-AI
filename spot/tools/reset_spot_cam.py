"""Power-cycle the Spot CAM to clear a camera_server fault.

Autowalk validates a mission against the services its actions need, so a
faulted camera server makes an inspection walk fail to load with nothing more
useful than "some part of the Walk was unable to initialize". The camera can
still serve single images while faulted, which makes it look healthy from the
dashboard and hides the reason the upload was refused.

Cycling the PTZ power is the least invasive thing that clears it: no reboot,
no lease, and the robot does not move.

    python spot/tools/reset_spot_cam.py
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

SPOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SPOT / "app"))

import dotenv  # noqa: E402

dotenv.load_dotenv(SPOT / "config.env")

import bosdyn.client  # noqa: E402
import bosdyn.client.spot_cam  # noqa: E402
from bosdyn.client.robot_state import RobotStateClient  # noqa: E402
from bosdyn.client.spot_cam.power import PowerClient  # noqa: E402

SPOT_IP = os.getenv("SPOT_IP", "192.168.33.137")


def faults(state_client) -> list[str]:
    state = state_client.get_robot_state()
    return sorted({f.name for f in state.system_fault_state.faults})


def main() -> int:
    sdk = bosdyn.client.create_standard_sdk("BridgeSpotCamReset")
    bosdyn.client.spot_cam.register_all_service_clients(sdk)

    robot = sdk.create_robot(SPOT_IP)
    try:
        robot.authenticate(os.getenv("BOSDYN_CLIENT_USERNAME", "").strip(),
                           os.getenv("BOSDYN_CLIENT_PASSWORD", "").strip())
    except Exception as exc:
        print(f"Could not authenticate: {exc}")
        return 1

    state_client = robot.ensure_client(RobotStateClient.default_service_name)
    before = faults(state_client)
    print(f"faults before : {before or 'none'}")
    if "camera_server" not in before:
        print("No camera_server fault to clear.")
        return 0

    power = robot.ensure_client(PowerClient.default_service_name)
    print("cycling Spot CAM PTZ power...")
    try:
        power.cycle_power(ptz=True)
    except Exception as exc:
        print(f"Power cycle failed: {exc}")
        return 1

    # The payload takes a while to come back and the fault clears only once the
    # camera server has re-registered, so this waits rather than reporting the
    # state a moment after the request.
    for waited in range(0, 90, 5):
        time.sleep(5)
        now = faults(state_client)
        print(f"  +{waited + 5:2}s  {now or 'none'}")
        if "camera_server" not in now:
            print("\ncamera_server fault cleared.")
            return 0

    print("\nStill faulted after 90s. The payload may need a reboot from the "
          "admin console, or the robot power-cycled.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
