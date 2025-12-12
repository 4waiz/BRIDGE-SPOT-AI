from enum import Enum, auto


class Modes(Enum):
    AUTOMATIC = auto()
    MANUAL = auto()


class States(Enum):
    # NOTE: only relevant for automatic mode
    IDLE = auto()  # robot is idle / waiting for tasks
    ESTOP = auto()  # robot has been estopped
    DRIVING = auto()  # robot is currently walking to destination
    WAITING = auto()  # robot is waiting for user input
