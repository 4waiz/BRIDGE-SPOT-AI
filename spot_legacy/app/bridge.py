"""
Changelog:
# 220214: Flexible logging files
# 220308: Logging with TimedRotatingFileHandler
# 220422: Logging with INOYADDailyFileHandler
# 220810: Fix Logfile deletion
# 220831: Backup Count for logging
# 221028: Automatic folder creation for log files
"""

import json
import logging
import os
import smtplib
import ssl
import sys
import time
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from logging.handlers import TimedRotatingFileHandler

import pytz
from dateutil import parser

CONFIG = {}


def load_config(config_file):
    with open(config_file, "r", encoding="utf-8") as file:
        globals()["CONFIG"] = json.load(file)


def start_logging(log_files):
    class LoggerWriter:
        def __init__(self, logfct):
            self.logfct = logfct
            self.buf = []

        def write(self, msg):
            if msg.endswith("\n"):
                if sys.version_info.major == 3 and sys.version_info.minor < 9:
                    remove_suffix(msg, "\n")
                else:
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


def send_email(
    mail_from,
    mail_to,
    mail_subject,
    mail_text,
    smtp_server,
    smtp_port=25,
    smtp_user=None,
    smtp_password=None,
):
    message = MIMEMultipart()
    message["From"] = mail_from
    message["To"] = mail_to
    message["Subject"] = mail_subject
    receivers = [mail_to]
    message.attach(MIMEText(mail_text, "plain"))
    context = ssl.create_default_context()
    with smtplib.SMTP(smtp_server, smtp_port) as server:
        if smtp_password is not None:
            server.starttls(context=context)
            try:
                if smtp_user is None:
                    smtp_user = mail_from
                server.login(smtp_user, smtp_password)
            except smtplib.SMTPAuthenticationError as e:
                logging.error("Wrong email address or password: %s", str(e))
                return
        try:
            server.sendmail(mail_from, receivers, message.as_string())
        except smtplib.SMTPRecipientsRefused as e:
            logging.error("Invalid receiver address: %s", str(e))


def read_last_write_time(filename):
    with open(filename, "r", encoding="utf-8") as file:
        file_content = file.read()
    last_write_time = parser.parse(file_content).replace(tzinfo=pytz.UTC)
    return last_write_time


def update_last_time_write(filename, time_string):
    last_write_time = parser.parse(time_string).replace(tzinfo=pytz.UTC)
    last_write_time = last_write_time.replace(tzinfo=pytz.UTC)
    last_write_time = last_write_time.isoformat()
    logging.info("New last time write value: %s", last_write_time)
    with open(filename, "w", encoding="utf-8") as f:
        f.write(last_write_time)


def remove_suffix(input_string, suffix):
    if suffix and input_string.endswith(suffix):
        return input_string[: -len(suffix)]
    return input_string

# Changes made by Awaiz Ahmed
