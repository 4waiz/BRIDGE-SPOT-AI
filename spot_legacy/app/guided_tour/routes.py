import http.client
import logging

from flask import Blueprint, render_template, request, make_response

from spot import spot, exceptions
from guided_tour import config, utils


routes = Blueprint("routes", __name__)


@routes.route("/", methods=["GET"])
def index():
    """Serve frontend for controlling Spot throughout guided LIF-Tour."""

    logging.info("Request on /")

    return render_template(
        "frontend.html",
        request=request,
        title="Guided LIF-Tour with Spot",
        estop_url=f"http://{config.SPOT_ESTOP_URL}",
    )


@routes.route("/navigate_to", methods=["POST"])
def navigate_to():
    """Navigate to station and play sound file."""

    station = request.args.get("station")

    if station is None:
        return _response("Please provide station as URL parameter!", 500)

    logging.info("Request on /navigate_to with station %s", station)

    # Acquire estop lease for Spot by connecting to estop server
    connection = http.client.HTTPConnection(config.SPOT_ESTOP_URL, timeout=60)
    connection.request("POST", "/acquire")
    response = connection.getresponse()
    RESPONSE_CODE = response.status
    logging.info(RESPONSE_CODE)
    if RESPONSE_CODE != 200:
        return _response(str(response.read().decode()), RESPONSE_CODE)

    if not config.SPOT_ROBOT:
        try:
            config.SPOT_ROBOT = spot.Spot(config.SPOT_IP, config.SPOT_UPLOAD_FILEPATH_BASE)
            config.SPOT_ROBOT.obtain_lease()
            if config.SPOT_ROBOT.is_docked():
                utils.release_all()
                return _response("Please undock first.", 400)
        except exceptions.SLFSpotError as err:
            return _response(str(err), 400)
        except exceptions.SLFSpotFailure as fail:
            return _response(str(fail), 500)
        except Exception as exc:
            logging.exception(exc)
            return _response("Unknown error", 500)
    map_code = config.SPOT_ROBOT.map_code
    try:
        config.SPOT_ROBOT.navigate_to(config.SPOT_DICT[map_code][station])
    except exceptions.SLFSpotError as err:
        return _response(str(err), 400)
    except exceptions.SLFSpotFailure as fail:
        return _response(str(fail), 500)
    except Exception as exc:
        logging.exception(exc)
        return _response("Unknown error", 500)
    return _response(f"{station} has been reached.", 200)


@routes.route("/play_sound", methods=["POST"])
def play_sound():
    """Play sound file."""
    # NOTE: can't be used unless one station has been navigated to already
    station = request.args.get("station")

    if station is None:
        return _response("Please provide station as URL parameter!", 500)

    logging.info("Request on /play_sound with station %s", station)

    if not config.SPOT_ROBOT:
        return _response(f"Can't play sound file for station {station}.", 400)

    try:
        config.SPOT_ROBOT.play_sound(f"{config.SPOT_SOUND_FILEPATH}/{config.SPOT_SOUNDS_DICT[station]}")
    except exceptions.SLFSpotError as err:
        return _response(str(err), 400)
    except exceptions.SLFSpotFailure as fail:
        return _response(str(fail), 500)
    except Exception as exc:
        logging.exception(exc)
        return _response("Unknown error", 500)
    return _response(f"Sound file for station {station} has been played.", 200)


@routes.route("/dock", methods=["POST"])
def dock():
    """Dock Spot."""

    logging.info("Request on /dock")

    if not config.SPOT_ROBOT:
        return _response("Can't dock robot.", 400)

    try:
        config.SPOT_ROBOT.dock(520)
    except exceptions.SLFSpotError as err:
        return _response(str(err), 400)
    except exceptions.SLFSpotFailure as fail:
        return _response(str(fail), 500)
    except Exception as exc:
        logging.exception(exc)
        return _response("Unknown error", 500)
    try:
        config.SPOT_ROBOT.release_lease()
    except exceptions.SLFSpotError as err:
        return _response(str(err), 400)
    except exceptions.SLFSpotFailure as fail:
        return _response(str(fail), 500)
    except Exception as exc:
        logging.exception(exc)
        return _response("Unknown error", 500)
    config.SPOT_ROBOT = None

    # Release estop lease for Spot by connecting to estop server
    connection = http.client.HTTPConnection(config.SPOT_ESTOP_URL, timeout=60)
    connection.request("POST", "/release")
    response = connection.getresponse()
    RESPONSE_CODE = response.status
    logging.info(RESPONSE_CODE)
    if RESPONSE_CODE != 200:
        return _response(str(response.read().decode()), RESPONSE_CODE)

    return _response("Spot has been docked. Please turn it off by using the button on its rear.", 201)


@routes.route("/undock", methods=["POST"])
def undock():
    """Undock Spot."""

    logging.info("Request on /undock")

    # Acquire estop lease for Spot by connecting to estop server
    connection = http.client.HTTPConnection(config.SPOT_ESTOP_URL, timeout=60)
    connection.request("POST", "/acquire")
    response = connection.getresponse()
    RESPONSE_CODE = response.status
    logging.info(f"Response from Estop acquire: {RESPONSE_CODE}")
    if RESPONSE_CODE != 200:
        return _response(str(response.read().decode()), RESPONSE_CODE)

    if not config.SPOT_ROBOT:
        try:
            config.SPOT_ROBOT = spot.Spot(config.SPOT_IP, config.SPOT_UPLOAD_FILEPATH_BASE)
            config.SPOT_ROBOT.obtain_lease()
        except exceptions.SLFSpotError as err:
            return _response(str(err), 400)
        except exceptions.SLFSpotFailure as fail:
            return _response(str(fail), 500)
        except Exception as exc:
            logging.exception(exc)
            return _response("Unknown error", 500)
    try:
        config.SPOT_ROBOT.undock()
    except exceptions.SLFSpotError as err:
        return _response(str(err), 400)
    except exceptions.SLFSpotFailure as fail:
        return _response(str(fail), 500)
    except Exception as exc:
        logging.exception(exc)
        return _response("Unknown error", 500)
    return _response("Spot has been undocked.", 200)


@routes.route("/release", methods=["POST"])
def release():
    """Release Spot."""

    logging.info("Request on /release")

    if not config.SPOT_ROBOT:
        return _response("No lease existing.", 200)

    try:
        utils.release_all()
    except exceptions.SLFSpotError as err:
        return make_response(str(err), 400)
    except exceptions.SLFSpotFailure as fail:
        return make_response(str(fail), 500)
    except Exception as exc:
        logging.exception(exc)
        return _response("Unknown error", 500)
    return _response("Spot has been released.", 200)


@routes.route("/map", methods=["POST"])
def set_map():
    """Change map"""

    logging.info("POST request on /map")
    map_code = request.data.decode("utf-8")
    if map_code not in config.SPOT_DICT.keys():
        return _response(f"Invalid map code ({map_code}). Data unchanged.", 400)

    with open("../data/map_code.txt", "w", encoding="utf-8") as f:
        f.write(map_code)
    if config.SPOT_ROBOT:
        config.SPOT_ROBOT.map_code = map_code

    return _response("Map code changed.", 200)


@routes.route("/map", methods=["GET"])
def get_map():
    """Get map"""
    logging.info("GET request on /map")
    with open("../data/map_code.txt", "r", encoding="utf-8") as f:
        map_code = f.read()
    if not map_code:
        return _response("Error", 500)
    return _response(map_code, 200)


def _response(msg: str, code: int):
    if code >= 200 and code < 300:
        logging.info("Response %d: %s", code, msg)
    elif code >= 400 and code < 500:
        logging.warning("Response %d: %s", code, msg)
    else:
        logging.error("Response %d: %s", code, msg)
    response = make_response(msg, code)
    response.mimetype = "text/plain"
    return response
