from datetime import datetime
import http.client
import logging
from flask import Blueprint, request, make_response

from smart_learning_factory import config, enums, utils
from spot import spot, exceptions

routes = Blueprint("routes", __name__)


@routes.route("/")
def index():
    # TODO: provide static status page including positional info / battery capacity

    logging.info("Request on /")
    return f"Application is running. UTC time: {datetime.utcnow()}"


@routes.route("/button", methods=["POST"])
def button():
    logging.info("Request on /button")

    if config.MODE != enums.Modes.AUTOMATIC:
        logging.debug(config.MODE)
        return _response("AUTOMATIC is not enabled. Ignoring button input...", 400)

    if config.FROM or not config.TO:
        logging.info("FROM: %s", config.FROM)
        logging.info("TO: %s", config.TO)
        return _response("Either FROM is not empty or TO is empty. Ignoring button input...", 400)

    if config.STATE != enums.States.WAITING:
        logging.debug(config.STATE)
        return _response(
            "Currently this robot is not in WAITING state. Ignoring button input...",
            400,
        )

    logging.info("Button has been pressed!")

    if not config.SPOT_ROBOT:
        return _response("Can not trigger button, if no robot lease has been acquired yet.", 400)

    map_code = config.SPOT_ROBOT.map_code
    try:
        config.STATE = enums.States.DRIVING
        config.SPOT_ROBOT.navigate_to(config.SPOT_DICT[map_code][config.TO])
        config.SPOT_ROBOT.play_sound(f"{config.SPOT_SOUND_FILEPATH}/parts_arrived.wav")
    except exceptions.SLFSpotError as err:
        config.STATE = enums.States.IDLE
        return _response(str(err), 400)
    except exceptions.SLFSpotFailure as fail:
        config.STATE = enums.States.IDLE
        return _response(str(fail), 500)
    except Exception as exc:
        logging.exception(exc)
        return _response("Unknown error", 500)
    msg = f"{config.TO} has been reached. Please release robot..."

    config.STATE = enums.States.WAITING
    config.TO = ""

    return _response(msg, 200)


@routes.route("/automatic", methods=["POST"])
def automatic():
    logging.info("Request on /automatic")

    if config.MODE == enums.Modes.AUTOMATIC and config.STATE != enums.States.ESTOP:
        config.STATE = enums.States.IDLE

    # Acquire estop lease for Spot by connecting to estop server
    connection = http.client.HTTPConnection(config.SPOT_ESTOP_URL, timeout=60)
    connection.request("POST", "/acquire")
    response = connection.getresponse()
    RESPONSE_CODE = response.status
    logging.info("estop acquire response: %s", RESPONSE_CODE)
    if RESPONSE_CODE != 200:
        return _response(str(response.read().decode()), RESPONSE_CODE)

    if config.MODE == enums.Modes.AUTOMATIC:
        config.STATE = enums.States.IDLE
        return _response("AUTOMATIC mode is already enabled!", 200)

    try:
        config.SPOT_ROBOT = spot.Spot(ip=config.SPOT_IP, upload_filepath_base=config.SPOT_UPLOAD_FILEPATH_BASE)
        config.SPOT_ROBOT.obtain_lease()
        config.SPOT_ROBOT.localize()
        config.SPOT_ROBOT.play_sound(f"{config.SPOT_SOUND_FILEPATH}/automatic_mode.wav")
    except exceptions.SLFSpotError as err:
        config.STATE = enums.States.IDLE
        utils.release_all()
        return _response(str(err), 400)
    except exceptions.SLFSpotFailure as fail:
        config.STATE = enums.States.IDLE
        return _response(str(fail), 500)
    except Exception as exc:
        logging.exception(exc)
        return _response("Unknown error", 500)

    config.MODE = enums.Modes.AUTOMATIC
    config.STATE = enums.States.IDLE
    config.FROM = ""
    config.TO = ""

    return _response("AUTOMATIC mode enabled!", 200)


@routes.route("/manual", methods=["POST"])
def manual():
    logging.info("Request on /manual")

    if config.MODE == enums.Modes.MANUAL:
        config.STATE = enums.States.IDLE
        return _response("MANUAL mode is already enabled!", 200)

    if config.STATE == enums.States.DRIVING:
        return _response("Cannot switch to MANUAL mode while state is DRIVING!", 400)

    if not config.SPOT_ROBOT:
        return _response(
            "Can not switch to manual mode, if no robot lease has been acquired yet.",
            400,
        )

    # Sit down Spot and release estop lease for Spot by connecting to estop server
    connection = http.client.HTTPConnection(config.SPOT_ESTOP_URL, timeout=60)
    connection.request("POST", "/sit_down")
    response = connection.getresponse()
    RESPONSE_CODE = response.status
    logging.info("estop sit_down status: %s", RESPONSE_CODE)
    if RESPONSE_CODE != 200:
        return _response(str(response.read().decode()), RESPONSE_CODE)

    try:
        config.SPOT_ROBOT.release_lease()
    except exceptions.SLFSpotError as err:
        return _response(str(err), 400)
    except exceptions.SLFSpotFailure as fail:
        return _response(str(fail), 500)
    except Exception as exc:
        logging.exception(exc)
        return _response("Unknown error", 500)
    # Acquire estop lease for Spot by connecting to estop server
    connection = http.client.HTTPConnection(config.SPOT_ESTOP_URL, timeout=60)
    connection.request("POST", "/release")
    response = connection.getresponse()
    RESPONSE_CODE = response.status
    logging.info(RESPONSE_CODE)
    if RESPONSE_CODE != 200:
        return _response(str(response.read().decode()), RESPONSE_CODE)

    config.SPOT_ROBOT = None
    config.MODE = enums.Modes.MANUAL
    config.STATE = enums.States.IDLE
    config.FROM = ""
    config.TO = ""

    return _response("MANUAL mode enabled!", 200)


@routes.route("/release", methods=["POST"])
def release():
    """Release robot from transport task."""

    logging.info("Request on /release")

    if config.MODE != enums.Modes.AUTOMATIC:
        logging.debug(config.MODE)
        return _response("Can't release robot, because it is not in AUTOMATIC mode.", 400)

    if config.STATE != enums.States.DRIVING and config.STATE != enums.States.WAITING:
        logging.debug(config.STATE)
        return _response("Can't release robot, because STATE needs to be DRIVING or WAITING.", 400)

    if config.FROM != "" and config.TO == "":
        logging.debug("FROM: %s", config.FROM)
        logging.debug("TO: %s", config.TO)
        return _response("Can't release robot, because either FROM is not empty or TO is empty!", 400)

    ID = request.args.get("id")

    if ID is None:
        return _response("Please provide po transport id as URL parameter!", 400)

    if ID == config.TRANSPORT_ID:
        if not config.SPOT_ROBOT:
            return _response("Can not release robot, if no robot lease has been acquired yet.", 400)
        map_code = config.SPOT_ROBOT.map_code
        try:
            config.STATE = enums.States.DRIVING
            config.SPOT_ROBOT.navigate_to(config.SPOT_DICT[map_code]["IN"])
        except exceptions.SLFSpotError as err:
            config.TRANSPORT_ID = ""
            config.STATE = enums.States.IDLE
            return _response(str(err), 400)
        except exceptions.SLFSpotFailure as fail:
            config.TRANSPORT_ID = ""
            config.STATE = enums.States.IDLE
            return _response(str(fail), 500)
        except Exception as exc:
            logging.exception(exc)
            return _response("Unknown error", 500)
        config.TRANSPORT_ID = ""
        config.STATE = enums.States.IDLE

        return _response("Transport task completed!", 200)

    return _response("Transport id does not match! Ignoring request...", 200)


@routes.route("/navigate-to-base", methods=["POST"])
def navigate_to_base():
    """Navigate to BASE."""

    logging.info("Request on /navigate-to-base")

    # check mode before starting drive
    if config.MODE != enums.Modes.AUTOMATIC:
        logging.debug(config.MODE)
        return _response("Please switch to automatic driving before navigating to BASE!", 400)

    # check state before starting drive
    if config.STATE != enums.States.IDLE:
        logging.debug(config.STATE)
        return _response(
            f"Currently the robot is in {config.STATE} state! It needs to be in IDLE state. Cannot navigate to BASE...",
            400,
        )

    if not config.SPOT_ROBOT:
        return _response(
            "Can not navigate robot to BASE, if no lease has been acquired yet.",
            400,
        )
    map_code = config.SPOT_ROBOT.map_code
    try:
        config.STATE = enums.States.DRIVING
        config.SPOT_ROBOT.navigate_to(config.SPOT_DICT[map_code]["BASE"])
    except exceptions.SLFSpotError as err:
        config.STATE = enums.States.IDLE
        return _response(str(err), 400)
    except exceptions.SLFSpotFailure as fail:
        config.STATE = enums.States.IDLE
        return _response(str(fail), 500)
    except Exception as exc:
        logging.exception(exc)
        return _response("Unknown error", 500)
    config.STATE = enums.States.IDLE

    return _response("Warehouse has been reached.", 200)


@routes.route("/route", methods=["POST"])
def route():
    """Parse route arguments and navigate to FROM."""

    logging.info("Request on /route")

    # check mode before starting drive
    if config.MODE != enums.Modes.AUTOMATIC:
        logging.debug(config.MODE)
        return _response("Please switch to automatic driving before sending routes!", 400)

    # check state before starting drive
    if config.STATE != enums.States.IDLE:
        return _response(
            f"Currently the robot is in {config.STATE} state! It needs to be in IDLE state. Ignoring route request...",
            400,
        )

    F = request.args.get("from")
    T = request.args.get("to")

    if F is None or T is None or F not in config.VALID_DEST or T not in config.VALID_DEST:
        str_valid_dest = str(config.VALID_DEST)
        return _response(
            f'Please provide valid URL parameters for "from" and "to"! Valid options are {str_valid_dest}.',
            400,
        )

    F = F.upper()
    T = T.upper()

    ID = request.args.get("id")

    if not ID:
        return _response(
            "Please provide current transport id as URL parameter.",
            400,
        )

    config.TRANSPORT_ID = ID
    config.FROM = F
    config.TO = T

    if not config.SPOT_ROBOT:
        return _response(
            "Can not navigate robot, if no lease has been acquired yet.",
            400,
        )
    map_code = config.SPOT_ROBOT.map_code
    try:
        config.STATE = enums.States.DRIVING
        config.SPOT_ROBOT.navigate_to(config.SPOT_DICT[map_code][config.FROM])
    except exceptions.SLFSpotError as err:
        config.STATE = enums.States.IDLE
        return _response(str(err), 400)
    except exceptions.SLFSpotFailure as fail:
        config.STATE = enums.States.IDLE
        return _response(str(fail), 500)
    except Exception as exc:
        logging.exception(exc)
        return _response("Unknown error", 500)
    msg = f"{config.FROM} has been reached. Please interact to continue route..."

    config.STATE = enums.States.WAITING
    config.FROM = ""

    return _response(msg, 200)


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
