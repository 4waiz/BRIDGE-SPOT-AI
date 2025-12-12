import logging
from datetime import datetime

from flask import Blueprint, make_response

from spot import spot, exceptions
from e_stop import config


routes = Blueprint("routes", __name__)


@routes.route("/", methods=["GET"])
def index():
    logging.info("Request on /")
    return f"Application is running. UTC time: {datetime.utcnow()}"


@routes.route("/allow", methods=["POST"])
def allow():
    """Allow estopped Spot."""

    logging.info("Request on /allow")

    if not config.SPOT_ESTOP:
        return _response("Can't allow e-stop.", 400)

    try:
        config.SPOT_ESTOP.estop_allow()
    except exceptions.SLFSpotError as err:
        return _response(str(err), 400)
    except exceptions.SLFSpotFailure as fail:
        return _response(str(fail), 500)
    except Exception as exc:
        logging.exception(exc)
        return _response("Unknown error", 500)
    return _response("Spot estop has been allowed!", 200)


@routes.route("/estop", methods=["POST"])
def estop():
    """Estop Spot."""

    logging.info("Request on /estop")

    if not config.SPOT_ESTOP:
        return _response("E-stop failed.", 400)

    try:
        config.SPOT_ESTOP.estop()
    except exceptions.SLFSpotError as err:
        return _response(str(err), 400)
    except exceptions.SLFSpotFailure as fail:
        return _response(str(fail), 500)
    except Exception as exc:
        logging.exception(exc)
        return _response("Unknown error", 500)
    return _response("Spot has been stopped!", 200)


@routes.route("/sit_down", methods=["POST"])
def sit_down():
    """Sit Spot down and release estop lease."""

    logging.info("Request on /sit_down")

    if not config.SPOT_ESTOP:
        return _response("Can't sit down spot.", 400)

    try:
        config.SPOT_ESTOP.cut_motor_power()
        # config.SPOT_ESTOP.release_estop()
    except exceptions.SLFSpotError as err:
        return _response(str(err), 400)
    except exceptions.SLFSpotFailure as fail:
        return _response(str(fail), 500)
    except Exception as exc:
        logging.exception(exc)
        return _response("Unknown error", 500)
    return _response("Spot has been sat down.", 200)


@routes.route("/acquire", methods=["POST"])
def acquire():
    """Acquire Spot cut motor power authority."""

    logging.info("Request on /acquire")

    if not config.SPOT_ESTOP:
        try:
            config.SPOT_ESTOP = spot.Spot(config.SPOT_IP, "")
        except exceptions.SLFSpotError as err:
            return _response(str(err), 400)
        except exceptions.SLFSpotFailure as fail:
            return _response(str(fail), 500)
        except Exception as exc:
            logging.exception(exc)
            return _response("Unknown error", 500)
    try:
        config.SPOT_ESTOP.obtain_cut_motor_power_authority()
    except exceptions.SLFSpotError as err:
        return _response(str(err), 400)
    except exceptions.SLFSpotFailure as fail:
        return _response(str(fail), 500)
    except Exception as exc:
        logging.exception(exc)
        return _response("Unknown error", 500)
    return _response("Spot estop lease has been acquired.", 200)


@routes.route("/release", methods=["POST"])
def release():
    """Release Spot estop lease."""

    logging.info("Request on /release")

    if not config.SPOT_ESTOP:
        return _response("No e-stop lease existing.", 200)

    try:
        config.SPOT_ESTOP.release_estop()
    except exceptions.SLFSpotError as err:
        return _response(str(err), 400)
    except exceptions.SLFSpotFailure as fail:
        return _response(str(fail), 500)
    except Exception as exc:
        logging.exception(exc)
        return _response("Unknown error", 500)
    config.SPOT_ESTOP = None

    return _response("Spot has been released.", 200)


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
