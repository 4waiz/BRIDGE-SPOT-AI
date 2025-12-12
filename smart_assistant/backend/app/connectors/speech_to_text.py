import logging
import time
import openai
import whisper


class SpeechToTextModule:
    def __init__(self, user_session):
        self.websocket = user_session.websocket
        self.session = user_session
        self.model = None
        self.client = openai.OpenAI()

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
            try:
                logging.exception(f"session {self.session.session_id}, request {request.id}: error in STT: {exc}")
                await self.session.send_json(json={"finish": "error in STT"})
            except Exception as wsexc:
                logging.exception(f"session {self.session.session_id}, request {request.id}: error in STT ws: {wsexc}")
            return None

    # the requests are timed out after 5 seconds and retried with exponential backoff. Adjusting the timeout to the length of the audio could increase performance
    def transcribe_with_retry(self, filename, lang, request):
        delay = 0.5
        base = 2
        max_retries = 4
        for retries in range(1, max_retries + 1):
            try:
                if self.model:
                    if lang != "multilingual":
                        return self.model.transcribe(audio=filename, language=lang)["text"].strip()
                    return self.model.transcribe(audio=filename)["text"].strip()
                else:
                    with open(filename, "rb") as audio_file:
                        if lang != "multilingual":
                            return self.client.audio.transcriptions.create(model="whisper-1", file=audio_file, timeout=10, language=lang).text
                        return self.client.audio.transcriptions.create(model="whisper-1", file=audio_file, timeout=10).text
            except (openai.RateLimitError, openai.APIError, openai.APITimeoutError) as exc:
                logging.exception(exc)
                time.sleep(delay)
                delay *= base
                if retries == max_retries:
                    raise exc
            logging.error(f"session {self.session.session_id}, request {request.id}: Retrying STT")
