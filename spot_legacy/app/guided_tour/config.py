import logging


# spot
# NOTE: needs to be adjusted every time a new map is imported / recorded
SPOT_DICT = {
    "df": {
        "BASE": "sparse-lynx-l3E+D9BHKyW3iHwmPdE1zQ==",
        "LEAN_AREA": "shorn-ewe-Ph5LlgefWoOkmysQHb44Pw==",
        "SMART_LEARNING_FACTORY": "eldest-bison-AnLKu40DPp21iIfhWb5.qA==",
        "INCUBATION_AREA": "jural-tiger-pW+ieTfh1CtrANTSGv.UWQ==",
        "EDGE_DIGITAL_FACTORY": "legato-hound-GLGSvQB1gQLpVqX6Cy.9mw==",
        "ANALYTICS_AREA": "mum-eagle-cTd7Xse4aeEZz8BzYTiDXw==",
        "SIX_SIGMA_AND_AGILE": "sparse-lynx-l3E+D9BHKyW3iHwmPdE1zQ==",
    },
    "inc": {
        "BASE": "prefab-heron-V.tuayibqZiMJiP3SF3U+w==",
        "LEAN_AREA": "sugary-shad-tChIku7lFiLdV4v55t..YA==",
        "SMART_LEARNING_FACTORY": "alated-merlin-atk6ez7m1w3KIGnFbkkzjA==",
        "INCUBATION_AREA": "hydric-lizard-IL.RDe.+6OgdMnoDF9qQWQ==",
        "EDGE_DIGITAL_FACTORY": "grungy-barker-1oHDyTwy03n3lqWE9fc5QQ==",
        "ANALYTICS_AREA": "diverse-cocoon-PcFYn9L3c5f4m9W420O0Jw==",
        "SIX_SIGMA_AND_AGILE": "prefab-heron-V.tuayibqZiMJiP3SF3U+w==",
    },
}

SPOT_SOUNDS_DICT = {
    "BASE": "station_1.wav",
    "LEAN_AREA": "station_2.wav",
    "SMART_LEARNING_FACTORY": "station_3.wav",
    "INCUBATION_AREA": "station_4.wav",
    "EDGE_DIGITAL_FACTORY": "station_5.wav",
    "ANALYTICS_AREA": "station_6.wav",
    "SIX_SIGMA_AND_AGILE": "station_7.wav",
}
SPOT_ROBOT = None
SPOT_ESTOP_URL = "192.168.208.88:8002"  # NOTE: do not include protocol
SPOT_UPLOAD_FILEPATH_BASE = "map"
SPOT_SOUND_FILEPATH = "./guided_tour/data"
SPOT_IP = "192.168.208.117"

# misc
LOG_FILES = [
    {
        "filename": "../log/guided_tour/server_error.log",
        "level": logging.ERROR,
        "backup_count": 90,
    },
    {
        "filename": "../log/guided_tour/server_info.log",
        "level": logging.INFO,
        "backup_count": 90,
    },
]
