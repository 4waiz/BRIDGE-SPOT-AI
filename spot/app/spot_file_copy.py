from data_acquisition_download import main
from datetime import datetime, timedelta, UTC
import dotenv
import os
import shutil
import zipfile
from exceptions import NoDataOnSpotException

dotenv.load_dotenv("../config.env")
ip = "192.168.208.117"


temp_folder_path = "../data/download_spot_temp/"
zip_directory_path = os.path.join(temp_folder_path, "REST")
image_folder = "../data/images"


def get_data_from_spot(mission_name):
    from_time = (datetime.now() - timedelta(days=2)).isoformat("T", "milliseconds") + "Z"
    to_time = datetime.now().isoformat("T", "milliseconds") + "Z"
    try:
        # Deletes pre-existing files from the folder
        for filename in os.listdir(temp_folder_path):
            file_path = os.path.join(temp_folder_path, filename)
            if os.path.isfile(file_path) or os.path.islink(file_path):
                os.unlink(file_path)
            elif os.path.isdir(file_path):
                shutil.rmtree(file_path)
                print(f"Deleted folder: {file_path}")
    except Exception as e:
        print(f"Failed to delete files in {temp_folder_path}. Reason: {e}")

    # Get data from spot
    arguments = [
        ip,
        "--query-from-timestamp",
        from_time,
        "--query-to-timestamp",
        to_time,
        "--destination-folder",
        temp_folder_path,
    ]
    main(arguments)

    # Extract zip files
    for filename in os.listdir(zip_directory_path):
        if filename.endswith(".zip"):
            zip_file_path = os.path.join(zip_directory_path, filename)
            with zipfile.ZipFile(zip_file_path, "r") as zip_ref:
                zip_ref.extractall(zip_directory_path)
            os.remove(zip_file_path)

    missions = os.listdir(zip_directory_path)
    missions_filtered = [mission_folder for mission_folder in missions if mission_name in mission_folder]
    if not missions_filtered:
        raise NoDataOnSpotException
    newest_mission_folder = missions_filtered[-1]
    newest_mission_folder_path = os.path.join(zip_directory_path, newest_mission_folder)
    jpg_files = [f for f in os.listdir(newest_mission_folder_path) if f.endswith(".jpg")]
    print(jpg_files)
    # Copy JPG files to the specified destination folder
    for jpg_file in jpg_files:
        source_file_path = os.path.join(newest_mission_folder_path, jpg_file)
        target_file_path = os.path.join(image_folder, mission_name)
        shutil.copy(source_file_path, target_file_path)
