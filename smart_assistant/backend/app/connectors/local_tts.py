"""Offline text-to-speech.

The OpenAI TTS call is the only reason an answer used to arrive silently (or,
worse, as an error banner) when the API key is dead. Windows already ships
SAPI voices, so we render the wav locally instead. Same wav bytes, same
websocket message, same avatar lip-sync -- the frontend cannot tell.

Rendering runs in a short-lived powershell process (see sapi_tts.ps1): the
managed System.Speech API is not reachable from CPython without pythonnet or
pywin32, neither of which is in this venv, and a subprocess costs ~0.4s for a
sentence-length utterance -- comfortably inside the time the avatar spends on
the previous sentence.
"""

import logging
import os
import shutil
import subprocess
import sys
import tempfile

_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sapi_tts.ps1")
_TIMEOUT = float(os.getenv("LOCAL_TTS_TIMEOUT", "20"))

# None = not checked yet.
_powershell = None
_available = None


def is_available():
    """True if we can render speech on this machine. Checked once."""
    global _powershell, _available
    if _available is not None:
        return _available
    if sys.platform != "win32":
        logging.info("Local TTS unavailable: SAPI is Windows-only.")
        _available = False
        return _available
    _powershell = shutil.which("powershell") or shutil.which("pwsh")
    if not _powershell:
        logging.info("Local TTS unavailable: no powershell on PATH.")
        _available = False
        return _available
    if not os.path.isfile(_SCRIPT):
        logging.info("Local TTS unavailable: missing %s.", _SCRIPT)
        _available = False
        return _available
    _available = True
    return _available


def synthesize(text, gender="male"):
    """Wav bytes for `text`, or None if local speech is not available. Never
    raises -- the caller falls back to a silent, text-only answer."""
    text = (text or "").strip()
    if not text or not is_available():
        return None

    text_path = wav_path = None
    try:
        handle, text_path = tempfile.mkstemp(suffix=".txt")
        with os.fdopen(handle, "w", encoding="utf-8") as fh:
            fh.write(text)
        handle, wav_path = tempfile.mkstemp(suffix=".wav")
        os.close(handle)

        result = subprocess.run(
            [
                _powershell,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                _SCRIPT,
                text_path,
                wav_path,
                "Female" if str(gender).lower() == "female" else "Male",
            ],
            capture_output=True,
            timeout=_TIMEOUT,
        )
        if result.returncode != 0:
            logging.warning(
                "Local TTS failed (exit %s): %s",
                result.returncode,
                result.stderr.decode("utf-8", "replace").strip()[:400],
            )
            return None

        with open(wav_path, "rb") as fh:
            audio = fh.read()
        # A header-only wav means the synthesiser produced nothing usable.
        return audio if len(audio) > 128 else None
    except Exception as exc:
        logging.warning("Local TTS error: %s", exc)
        return None
    finally:
        for path in (text_path, wav_path):
            if path:
                try:
                    os.remove(path)
                except OSError:
                    pass
