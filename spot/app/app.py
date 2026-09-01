from fastapi import FastAPI, Query
import control_api
import digital_factory
import hsse
import labeling_api
import spot_file_copy
from fastapi.staticfiles import StaticFiles
from starlette.responses import RedirectResponse
from exceptions import NoDataOnSpotException
from fastapi.responses import PlainTextResponse
import os
import socket
import bridge_logger
import logging
from bosdyn.client.exceptions import UnableToConnectToRobotError

app = FastAPI()

# Save a copy in 'latest' folder
LATEST_FOLDER_PATH = "../data/latest"
LOG_FILES = [
    {
        "filename": "../log/spot_ai_server_error.log",
        "level": logging.ERROR,
        "backup_count": 90,
    },
    {
        "filename": "../log/spot_ai_server_info.log",
        "level": logging.INFO,
        "backup_count": 90,
    },
]
bridge_logger.start_logging(LOG_FILES)

os.makedirs(LATEST_FOLDER_PATH, exist_ok=True)

app.mount("/static", StaticFiles(directory="../frontend"), name="static")
app.mount("/latest", StaticFiles(directory=LATEST_FOLDER_PATH), name="latest")

# Live robot control endpoints under /api/robot
app.include_router(control_api.router)

# HSSE dataset labelling endpoints under /api/labeling
app.include_router(labeling_api.router)


# Frontend
@app.get("/")
async def forward():
    url = "/static/index.html"
    return RedirectResponse(url)


@app.get("/api/lan-ip")
def lan_ip():
    """Return the outbound LAN address of this host.

    The Home page reads this to swap a `localhost` URL for the same server's
    wifi IP, so anyone else on the network can type what they see in the URL
    bar and reach the same page. Uses a UDP socket to a public address as
    the interface probe: no packet is actually sent, but the OS fills in the
    source IP it would use, which is the one we want. `gethostbyname` is
    unreliable on Windows -- it often returns 127.0.0.1 or an APIPA address
    depending on how the hosts file is configured.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("8.8.8.8", 80))
        ip = probe.getsockname()[0]
    except OSError:
        ip = None
    finally:
        probe.close()
    return {"ip": ip}


@app.get("/analyzefromspot")
def analyze_spot(source: str = Query("DigitalFactory", enum=["DigitalFactory", "HSSE"])):
    try:
        spot_file_copy.get_data_from_spot(source)

        if source == "DigitalFactory":
            response_content = digital_factory.analyze(source)
        elif source == "HSSE":
            response_content = hsse.analyze(source)
        else:
            msg = f"Invalid source parameter: {source}. Must be 'DigitalFactory' or 'HSSE'."
            logging.error(msg)
            return PlainTextResponse(msg, 400)

    except UnableToConnectToRobotError:
        msg = "Cannot connect to Spot. Make sure you are in the right WIFI and Spot is on"
        logging.error(msg)
        return PlainTextResponse(msg, 500)

    except NoDataOnSpotException:
        msg = "No finished mission data found on Spot for last 24h"
        logging.error(msg)
        return PlainTextResponse(msg, 500)

    except Exception as exc:
        logging.exception(exc)
        return PlainTextResponse("Unknown Error", 500)

    return PlainTextResponse(response_content, 200)
# Changes made by Awaiz Ahmed
