import logging
import os
import sys
import time
from logging.handlers import TimedRotatingFileHandler


def start_logging(log_files):
    class LoggerWriter:
        def __init__(self, logfct):
            self.logfct = logfct
            self.buf = []

        def write(self, msg):
            if msg.endswith("\n"):
                self.buf.append(msg.removesuffix("\n"))
                self.logfct("".join(self.buf))
                self.buf = []
            else:
                self.buf.append(msg)

        def flush(self):
            pass

    # Logger
    logger = logging.getLogger()
    logger.handlers.clear()  # disable duplicate logging when using uvicorn
    logger.setLevel(logging.DEBUG)

    # Format
    formatter = logging.Formatter("%(asctime)s | %(name)s | %(levelname)s: %(message)s")

    # File handlers
    for log_file in log_files:
        handler = INOYADDailyFileHandler(log_file["filename"], log_file["backup_count"])
        handler.setLevel(log_file["level"])
        handler.setFormatter(formatter)
        logger.addHandler(handler)

    # Redirect stderr to logger
    sys.stderr = LoggerWriter(logger.critical)

    # write logs to stdout as well
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(logging.DEBUG)
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)

    # Disable asyncio logs
    logging.getLogger("asyncio").disabled = True

    # Disable uvicorn stderr logs to prevent confusion with logger.critical
    uvicorn_logger = logging.getLogger("uvicorn")
    uvicorn_logger.handlers.clear()


class INOYADDailyFileHandler(TimedRotatingFileHandler):
    # Based on TimedRotatingFileHandler, without renaming files
    def __init__(self, filenamebasename, backupCount):
        self.filenamebasename = filenamebasename
        self.filenameext = "log"
        self.create_log_dir(filenamebasename)
        filename = self.getCurrentFilename()
        logging.handlers.TimedRotatingFileHandler.__init__(
            self,
            filename,
            when="midnight",
            interval=1,
            backupCount=backupCount,
            encoding="utf-8",
            delay=True,
        )
        for s in self.getFilesToDelete():
            os.remove(s)

    def create_log_dir(self, filenamebasename: str):
        full_path = os.path.realpath(filenamebasename)
        path, _ = os.path.split(full_path)
        os.makedirs(path, exist_ok=True)

    def getCurrentFilename(self):
        filename = self.filenamebasename + "_" + time.strftime("%Y-%m-%d") + "." + self.filenameext
        absfilename = os.path.abspath(filename)
        return absfilename

    def rotate(self, _source, _dest):
        # Overwritten, change of variable instead of rename
        self.baseFilename = self.getCurrentFilename()

    def getFilesToDelete(self):
        # Overwritten, use of filenamebasename
        dirName = os.path.dirname(self.baseFilename)
        fileNames = os.listdir(dirName)
        result = []
        for fileName in fileNames:
            if fileName.startswith(os.path.basename(self.filenamebasename)) and fileName.endswith(self.filenameext):
                result.append(os.path.join(dirName, fileName))
        if len(result) < self.backupCount:
            result = []
        else:
            result.sort()
            result = result[: len(result) - self.backupCount]
        return result

# Changes made by Awaiz Ahmed
