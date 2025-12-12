import logging
from smart_learning_factory import enums

# general
STATE = enums.States.IDLE  # states: idle, estop, driving, waiting
MODE = enums.Modes.MANUAL  # modes: manual, automatic
VALID_DEST = ["A", "B", "C", "D", "IN", "BASE"]
TRANSPORT_ID = ""
FROM = ""
TO = ""

# spot
SPOT_DICT = {
    "df": {
        "A": "ornery-lynx-.hDLOGRNGNsZAIb.JLOZZw==",
        "B": "sent-cowrie-Svg1t.sx0IIlLmPfFLAd2A==",
        "C": "birken-botfly-.SobqESgWErzKVAI94..MQ==",
        "D": "drafty-beaver-ShR4Hw6Ul4C7vILmqlGI1g==",
        "IN": "floaty-cod-D9CywJoLtZhkxn9ODgOFEA==",
        "BASE": "floaty-cod-D9CywJoLtZhkxn9ODgOFEA==",
    },
    "inc": {
        "A": "pilary-squid-IlhsQEKbwZ9RgNwQURkwNw==",
        "B": "aided-spawn-BqBdpR+G1arzwjkNpFaUuQ==",
        "C": "shirty-guinea-MSCCThuRwsezrvOu4RY.Yg==",
        "D": "furred-doe-PNXbY01iK+otGjHnVqwbPw==",
        "IN": "aglow-kiwi-GAbEJ88.NJZmnkgbPZd.ng==",
        "BASE": "aglow-kiwi-GAbEJ88.NJZmnkgbPZd.ng==",
    },
}
SPOT_ROBOT = None
SPOT_ESTOP_URL = "192.168.208.88:8002"  # NOTE: do not include protocol
SPOT_UPLOAD_FILEPATH_BASE = "map"
SPOT_SOUND_FILEPATH = "./smart_learning_factory/data"
SPOT_IP = "192.168.208.117"

# misc
LOG_FILES = [
    {
        "filename": "../log/slf/server_error.log",
        "level": logging.ERROR,
        "backup_count": 90,
    },
    {
        "filename": "../log/slf/server_info.log",
        "level": logging.INFO,
        "backup_count": 90,
    },
]
