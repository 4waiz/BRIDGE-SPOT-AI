import http.client
import logging

from spot import exceptions
from smart_learning_factory import config


def release_all():
    # Sit down stop
    connection = http.client.HTTPConnection(config.SPOT_ESTOP_URL, timeout=60)
    connection.request("POST", "/sit_down")
    response = connection.getresponse()
    RESPONSE_CODE = response.status
    logging.info(RESPONSE_CODE)
    if RESPONSE_CODE != 200:
        logging.warning(response.read().decode())
        if RESPONSE_CODE == 400:
            raise exceptions.SLFSpotError(response.read().decode())
        else:
            raise exceptions.SLFSpotFailure(response.read().decode())

    # release lease
    config.SPOT_ROBOT.release_lease()

    # delete robot object
    config.SPOT_ROBOT = None

    # Acquire estop lease for Spot by connecting to estop server
    connection = http.client.HTTPConnection(config.SPOT_ESTOP_URL, timeout=60)
    connection.request("POST", "/release")
    response = connection.getresponse()
    RESPONSE_CODE = response.status
    logging.info(RESPONSE_CODE)
    if RESPONSE_CODE != 200:
        logging.warning(response.read().decode())
        if RESPONSE_CODE == 400:
            raise exceptions.SLFSpotError(response.read().decode())
        else:
            raise exceptions.SLFSpotFailure(response.read().decode())
