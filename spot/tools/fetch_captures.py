"""Download the photographs a mission took, off the robot's data acquisition store.

Autowalk actions do not send images back to whoever started the mission: they
write them into the robot's own store, keyed by the action name. So a mission
can run perfectly and leave the dashboard with nothing to show until they are
fetched.

    python spot/tools/fetch_captures.py --contains HSSE
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

SPOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SPOT / "app"))

import dotenv  # noqa: E402

dotenv.load_dotenv(SPOT / "config.env")

import bosdyn.client  # noqa: E402
import bosdyn.client.spot_cam  # noqa: E402
from bosdyn.api import data_acquisition_store_pb2  # noqa: E402
from bosdyn.client.data_acquisition_store import DataAcquisitionStoreClient  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--contains", default="HSSE",
                    help="only actions whose name contains this")
    ap.add_argument("--out", default=str(SPOT / "spot data 2025" / "capture mission"))
    args = ap.parse_args()

    sdk = bosdyn.client.create_standard_sdk("BridgeFetchCaptures")
    bosdyn.client.spot_cam.register_all_service_clients(sdk)
    robot = sdk.create_robot(os.getenv("SPOT_IP", "192.168.33.137"))
    robot.authenticate(os.getenv("BOSDYN_CLIENT_USERNAME", "").strip(),
                       os.getenv("BOSDYN_CLIENT_PASSWORD", "").strip())

    store = robot.ensure_client(DataAcquisitionStoreClient.default_service_name)

    # An empty query means everything the store holds.
    actions = store.list_capture_actions(data_acquisition_store_pb2.DataQueryParams())
    print(f"{len(actions)} capture action(s) on the robot")
    wanted = [a for a in actions if args.contains.lower() in a.action_name.lower()]
    if not wanted:
        print(f"None match {args.contains!r}. Names seen:")
        for a in actions[-12:]:
            print(f"   {a.action_name!r} (group {a.group_name!r})")
        return 1

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    saved = 0

    for action in wanted:
        images = store.list_stored_images(query=None)
        for img in images:
            if img.action_id.action_name != action.action_name:
                continue
            # The store returns metadata; the image itself comes back by id.
            try:
                data = store.get_image(img.data_id) if hasattr(store, "get_image") else None
            except Exception as exc:
                print(f"  {action.action_name}: could not read image: {exc}")
                continue
            if data is None:
                continue
            name = (f"{action.action_name}_{img.data_id.channel or 'ptz'}"
                    .replace(" ", "_").replace("/", "_") + ".jpg")
            (out / name).write_bytes(data)
            saved += 1
            print(f"  saved {name}")

    print()
    print(f"{saved} image(s) written to {out}")
    return 0 if saved else 1


if __name__ == "__main__":
    raise SystemExit(main())
