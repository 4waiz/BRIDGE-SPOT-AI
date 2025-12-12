import logging


# spot
SPOT_ESTOP = None
SPOT_IP = "192.168.208.117"

# misc
LOG_FILES = [
    {
        "filename": "../log/e_stop/server_error.log",
        "level": logging.ERROR,
        "backup_count": 90,
    },
    {
        "filename": "../log/e_stop/server_info.log",
        "level": logging.INFO,
        "backup_count": 90,
    },
]
