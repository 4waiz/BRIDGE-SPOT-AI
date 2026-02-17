import logging
import sys


if __name__ == "__main__":
    app_type = sys.argv[1]
    if app_type == "e_stop":
        from e_stop import app
    elif app_type == "guided_tour":
        from guided_tour import app
    elif app_type == "smart_learning_factory":
        from smart_learning_factory import app
    else:
        logging.error("Wrong app_type! Exiting...")
        sys.exit(1)

    app.run(processes=1, host="0.0.0.0", port=8004)
    logging.info("server starting...")
