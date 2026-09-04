import logging
import os
import threading
import time
import wave

import numpy as np
import openai
import whisper

# Whisper size used when we have to transcribe locally. "base" is the largest
# model that keeps a short question under a couple of seconds on CPU; the
# weights are ~140 MB and are fetched once into ~/.cache/whisper, after which
# transcription needs no network at all.
LOCAL_MODEL_NAME = os.getenv("LOCAL_STT_MODEL", "base")

_local_model = None
_local_model_tried = False
_local_model_lock = threading.Lock()


def get_local_model():
    """The shared offline Whisper model, or None if it cannot be obtained.
    Loaded on first use rather than at import so a machine that never loses
    the API key never pays for it."""
    global _local_model, _local_model_tried
    with _local_model_lock:
        if _local_model_tried:
            return _local_model
        _local_model_tried = True
        try:
            t0 = time.time()
            logging.info("Loading local Whisper model '%s' for offline STT...", LOCAL_MODEL_NAME)
            _local_model = whisper.load_model(LOCAL_MODEL_NAME)
            logging.info("Local Whisper model ready in %.1fs.", time.time() - t0)
        except Exception as exc:
            logging.warning("Local Whisper unavailable (%s); voice input needs the API.", exc)
            _local_model = None
        return _local_model


def load_wav_for_whisper(filename):
    """Decode the recording ourselves into the float32 mono array Whisper
    wants. Passing a path instead would make Whisper shell out to ffmpeg,
    which is not installed on the demo machine -- and the file is already a
    plain PCM wav written by Request.handle_audio, so there is nothing for
    ffmpeg to do."""
    with wave.open(filename, "rb") as wav_file:
        channels = wav_file.getnchannels()
        width = wav_file.getsampwidth()
        rate = wav_file.getframerate()
        frames = wav_file.readframes(wav_file.getnframes())

    dtype, full_scale = {
        2: (np.int16, 2.0**15),
        4: (np.int32, 2.0**31),
    }[width]
    audio = np.frombuffer(frames, dtype=dtype).astype(np.float32) / full_scale
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != whisper.audio.SAMPLE_RATE:
        # Whisper is hard-wired to 16 kHz; linear interpolation is plenty for
        # speech and avoids pulling in a resampler.
        target_len = int(round(len(audio) * whisper.audio.SAMPLE_RATE / rate))
        audio = np.interp(
            np.linspace(0, len(audio), target_len, endpoint=False),
            np.arange(len(audio)),
            audio,
        ).astype(np.float32)
    return np.ascontiguousarray(audio, dtype=np.float32)


class SpeechToTextModule:
    def __init__(self, user_session):
        self.websocket = user_session.websocket
        self.session = user_session
        # Explicitly selected local model (frontend "stt" setting). None means
        # "use the API, and fall back to the shared local model if it fails".
        self.model = None

    def load_model(self, model):
        if model:
            self.model = whisper.load_model(model)
        else:
            self.model = None

    # send audio file to whisper api and return the response
    async def recognize_audio(self, filename, request):
        try:
            logging.info(f"session {self.session.session_id}, request {request.id}: Recognizing audio: {filename}")
            result = self.transcribe_with_retry(filename, self.session.language, request)
            logging.info(f"session {self.session.session_id}, request {request.id}: Recognized audio for {filename}: {result}")
            return result
        except Exception as exc:
            logging.exception(f"session {self.session.session_id}, request {request.id}: error in STT: {exc}")
            # Last resort: transcribe on this machine. Keeps voice input alive
            # when the key is dead, which is the whole point of the offline path.
            result = self.transcribe_locally(filename, self.session.language)
            if result:
                logging.info(f"session {self.session.session_id}, request {request.id}: Local STT recognized: {result}")
                return result
            # No transcript. Returning None routes the request into the
            # "I didn't understand you" reply, which is a normal answer -- an
            # error finish here would blank the panel instead.
            return None

    def transcribe_locally(self, filename, lang):
        model = self.model or get_local_model()
        if model is None:
            return None
        try:
            audio = load_wav_for_whisper(filename)
            if lang != "multilingual":
                return model.transcribe(audio=audio, language=lang)["text"].strip()
            return model.transcribe(audio=audio)["text"].strip()
        except Exception as exc:
            logging.warning("Local STT failed: %s", exc)
            return None

    # the requests are timed out after 5 seconds and retried with exponential backoff. Adjusting the timeout to the length of the audio could increase performance
    def transcribe_with_retry(self, filename, lang, request):
        # An explicitly chosen local model, or no usable API at all: transcribe
        # here. Raising instead would log a traceback for something we already
        # know, on every single utterance.
        if self.model or self.session.client is None:
            return self.transcribe_locally(filename, lang)

        delay = 0.5
        base = 2
        max_retries = 4
        for retries in range(1, max_retries + 1):
            client = self.session.client
            try:
                with open(filename, "rb") as audio_file:
                    if lang != "multilingual":
                        return client.audio.transcriptions.create(model="gpt-4o-mini-transcribe", file=audio_file, timeout=10, language=lang).text
                    return client.audio.transcriptions.create(model="gpt-4o-mini-transcribe", file=audio_file, timeout=10).text
            except openai.AuthenticationError as exc:
                # Retrying a rejected key just delays the local transcription.
                logging.error("OpenAI rejected the API key in STT; switching to local transcription.")
                self.session.disable_openai()
                raise exc
            except (openai.RateLimitError, openai.APIError, openai.APITimeoutError) as exc:
                logging.exception(exc)
                time.sleep(delay)
                delay *= base
                if retries == max_retries:
                    raise exc
            logging.error(f"session {self.session.session_id}, request {request.id}: Retrying STT")
