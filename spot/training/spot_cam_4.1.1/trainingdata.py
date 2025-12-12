import importlib
import sys
import os
from time import sleep

command_line = importlib.import_module("command_line")

sys.argv = [os.path.basename(__file__), "192.168.208.117", "media_log", "store_retrieve", "ptz"]

while True:
    command_line.main()