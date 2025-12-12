import logging


class SLFSpotError(Exception):
    """raise when handling specific spot error"""

    def __init__(self, *args: object) -> None:
        logging.warning(msg=args[0])
        super().__init__(*args)


class SLFSpotFailure(Exception):
    """raise when spot error occurred that hasn't been handled yet"""

    def __init__(self, *args: object) -> None:
        logging.error(msg=args[0])
        super().__init__(*args)
