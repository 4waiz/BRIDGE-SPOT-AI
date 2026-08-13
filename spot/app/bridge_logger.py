import logging
import os
import time
from logging.handlers import TimedRotatingFileHandler
import sys


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
    logger.setLevel(logging.DEBUG)

    # Format
    formatter = logging.Formatter("%(asctime)s | %(name)s | %(levelname)s: %(message)s")

    # File handlers
    for log_file in log_files:
        handler = INOYADDailyFileHandler(log_file["filename"], log_file["backup_count"])
        handler.setLevel(log_file["level"])
        handler.setFormatter(formatter)
        logger.addHandler(handler)

    # TensorFlow calls logging.basicConfig() while importing, which attaches a
    # console handler to the root logger. Combined with the DEBUG level above
    # that turns every third-party debug record into console spam. Clamp the
    # console to warnings and let the files keep the full detail.
    for handler in logger.handlers:
        if isinstance(handler, logging.StreamHandler) and not isinstance(handler, logging.FileHandler):
            handler.setLevel(logging.WARNING)

    # Chatty third-party loggers with nothing useful to say at this level.
    for noisy in ("h5py", "matplotlib", "PIL", "urllib3", "grpc"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    # Keras warns through absl once per .h5 that "compiled metrics have yet to
    # be built". These models are only ever used for inference, so that is
    # expected for every load and would otherwise print on every start.
    logging.getLogger("absl").setLevel(logging.ERROR)

    # Redirect stderr to logger
    sys.stderr = LoggerWriter(logger.critical)


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

    def rotate(self, source, dest):
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
