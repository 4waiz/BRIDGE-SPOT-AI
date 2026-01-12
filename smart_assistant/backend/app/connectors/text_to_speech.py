import base64
import json
import logging
import os
import time
import traceback
from threading import Lock

try:
    import sounddevice as sd
except OSError:
    print("No server side audio possible - no sound card available.")

import queue
import threading
import wave

import azure.cognitiveservices.speech as speechsdk
import numpy as np
from scipy.signal import resample

# Make speech optional so the assistant can start without Azure creds.
SPEECH_KEY = os.getenv("SPEECH_KEY")
SPEECH_REGION = os.getenv("SPEECH_REGION")
AZURE_SPEECH_ENABLED = bool(SPEECH_KEY and SPEECH_REGION)

# Audio configuration
SAMPLE_RATE = 16000  # Set this to match the audio sample rate of your TTS engine
CHANNELS = 1  # Mono audio, if that's what your TTS engine outputs
DTYPE = "int16"  # Assuming 16-bit audio; adjust if needed
OUTPUT_AMPLIFICATION_FACTOR = 1.9  # Adjust as needed

# Queue for buffering audio data
audio_queue = queue.Queue()
server_audio_lock = Lock()  # Lock to ensure only one thread plays audio at a time


no_question_lang_dict = {
    "multilingual": "I'm sorry, but I didn't understand you. Please try again.",
    "en": "I'm sorry, but I didn't understand you. Please try again.",
    "ar": "أنا آسف ، لكنني لم أفهمك. يرجى المحاولة مرة أخرى.",
    "hi": "क्षमा करें, लेकिन मैं आपको समझ नहीं पाया। कृपया पुन: प्रयास करें.",
    "de": "Entschuldigung, ich habe Sie nicht verstanden. Bitte versuchen Sie es nochmal.",
    "es": "Lo siento, pero no te entendí. Por favor, inténtelo de nuevo.",
    "pt": "Sinto muito, mas não te entendi. Por favor, tente novamente.",
    "sv": "Jag är ledsen, men jag förstod dig inte. Var god försök igen.",
    "nl": "Het spijt me, maar ik begreep je niet. Probeer het opnieuw.",
    "ru": "Извините, но я вас не понял. Повторите попытку.",
    "fr": "Je suis désolé, mais je ne vous ai pas compris. Veuillez réessayer.",
    "zh": "对不起，我不明白你。请再试一次。",
}

greeting_lang_dict = {
    "multilingual": "Hello, I'm (). Just click on the button and ask me anything.",
    "en": "Hello, I'm (). Just click on the button and ask me anything.",
    "ar": "مرحبا أنا (). فقط اضغط على الزر واسألني أي شيء.",
    "hi": "नमस्ते मैं ()। बस बटन पर क्लिक करें और मुझसे कुछ भी पूछें।",
    "de": "Hallo, ich bin (). Klick einfach auf den Knopf und frag mich, was du willst.",
    "es": "Hola soy (). Simplemente haga clic en el botón y pregúnteme cualquier cosa.",
    "pt": "Olá eu sou (). Basta clicar no botão e me perguntar qualquer coisa.",
    "sv": "Hej jag är (). Klicka bara på knappen och fråga mig vad som helst.",
    "nl": "Hallo ik ben (). Klik gewoon op de knop en vraag me alles.",
    "ru": "Здравствуйте, я (). Просто нажмите на кнопку и спросите меня о чем угодно.",
    "fr": "Bonjour je suis (). Cliquez simplement sur le bouton et demandez-moi n'importe quoi.",
    "zh": "你好，我叫 ()。 只需点击按钮并询问我任何事情即可。",
}

# Some locales do not provide blendshapes, so the multilingual voice has to be used instead
# Jenny V2 currently in preview, to be changed in Q4 2023, then change back to JennyMultilingualNeural
voice_lang_dict = {
    ("female", "multilingual"): "en-US-JennyMultilingualV2Neural",
    ("male", "multilingual"): "en-US-RyanMultilingualNeural",
    ("female", "en"): "en-US-JaneNeural",
    ("male", "en"): "en-US-JasonNeural",
    ("female", "ar"): "en-US-JennyMultilingualV2Neural",
    ("male", "ar"): "en-US-RyanMultilingualNeural",
    ("female", "hi"): "hi-IN-SwaraNeural",
    ("male", "hi"): "hi-IN-MadhurNeural",
    ("female", "de"): "de-DE-KatjaNeural",
    ("male", "de"): "de-DE-ConradNeural",
    ("female", "es"): "es-CO-SalomeNeural",
    ("male", "es"): "es-MX-JorgeNeural",
    ("female", "pt"): "pt-BR-FranciscaNeural",
    ("male", "pt"): "pt-BR-AntonioNeural",
    ("female", "sv"): "en-US-JennyMultilingualV2Neural",
    ("male", "sv"): "en-US-RyanMultilingualNeural",
    ("female", "nl"): "en-US-JennyMultilingualV2Neural",
    ("male", "nl"): "en-US-RyanMultilingualNeural",
    ("female", "ru"): "ru-RU-SvetlanaNeural",
    ("male", "ru"): "ru-RU-DmitryNeural",
    ("female", "fr"): "fr-FR-DeniseNeural",
    ("male", "fr"): "fr-FR-HenriNeural",
    ("female", "zh"): "zh-CN-XiaoqiuNeural",
    ("male", "zh"): "zh-CN-YunyangNeural",
}


def transpose(matrix):
    if matrix == []:
        return []
    return [[matrix[row][col] for row in range(0, len(matrix))] for col in range(0, len(matrix[0]))]


def play_audio():
    while True:
        # Blocking get: waits until an item is available in the queue
        audio_data = audio_queue.get()

        # Acquire the lock to ensure exclusive access to audio playback
        with server_audio_lock:
            # Convert bytes to numpy array if needed
            audio_array = np.frombuffer(audio_data, dtype=DTYPE)
            audio_array = np.clip(audio_array * OUTPUT_AMPLIFICATION_FACTOR, np.iinfo(DTYPE).min, np.iinfo(DTYPE).max).astype(DTYPE)
            # Execute playback, initialize the output stream
            with sd.OutputStream(samplerate=SAMPLE_RATE, channels=CHANNELS, dtype=DTYPE) as stream:
                stream.write(audio_array)


def add_fade_in(audio_data, fade_duration=0.1):  # 100 ms fade-in
    num_samples = int(fade_duration * SAMPLE_RATE)

    # Convert bytes to numpy array
    audio_array = np.frombuffer(audio_data, dtype=DTYPE).astype(np.float32)

    # Handle rare case where audio is shorter than fade-in duration
    actual_num_samples = min(len(audio_array), num_samples)
    if actual_num_samples == 0:
        return audio_data  # Return unchanged if audio is empty

    fade_in = np.linspace(0, 1, actual_num_samples).astype(np.float32)

    # Apply fade-in
    audio_array[:actual_num_samples] *= fade_in

    # Convert back to bytes
    return audio_array.astype(np.int16).tobytes()


class TextToSpeechModule:
    def __init__(self, user_session, play_locally=True):
        self.websocket = user_session.websocket  # websocket of the current connection
        self.playback_speed = "1"
        self.session = user_session
        self.speech_config = (
            speechsdk.SpeechConfig(subscription=SPEECH_KEY, region=SPEECH_REGION)
            if AZURE_SPEECH_ENABLED
            else None
        )
        self.gender = "female"
        self.blenddata = []
        self.playback_thread = None

    def viseme_cb(self, event):
        animation_dict = json.loads(event.animation)
        for frame in animation_dict["BlendShapes"]:
            self.blenddata.append(frame)

    async def speak(self, text, request, play_locally=False):
        try:
            if not AZURE_SPEECH_ENABLED:
                logging.warning("Azure Speech not configured; skipping TTS playback.")
                return
            # Create SSML
            xml_lang = self.session.language if self.session.language != "multilingual" else "en"
            ssml = f"""<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="{xml_lang}">
                            <voice name="{voice_lang_dict[(self.gender, self.session.language)]}">
                                <mstts:viseme type="FacialExpression"/>
                                <prosody rate="{self.playback_speed}">"{text}"</prosody>
                            </voice>
                        </speak>"""
            # Create synthesizer
            self.synthesizer = speechsdk.SpeechSynthesizer(speech_config=self.speech_config, audio_config=None)
            self.synthesizer.viseme_received.connect(self.viseme_cb)
            result = self.synthesizer.speak_ssml_async(ssml).get()

            if result.reason == speechsdk.ResultReason.Canceled:
                cancellation_details = result.cancellation_details
                logging.info(f"session {self.session.session_id}, request {request.id}: Speech synthesis canceled for text: {text}\nCancellation reason: {cancellation_details.reason}")
                if cancellation_details.reason == speechsdk.CancellationReason.Error:
                    if cancellation_details.error_details:
                        logging.info(f"session {self.session.session_id}, request {request.id}: Error details: {cancellation_details.error_details}")

            audio_bytes = result.audio_data
            audio_duration = result.audio_duration.total_seconds()

            if play_locally:
                if not self.playback_thread:
                    self.playback_thread = threading.Thread(target=play_audio)
                    self.playback_thread.daemon = True  # Daemon mode so it stops when main program exits
                    self.playback_thread.start()
                # There is a clicking sound in between sound batches with pyaudio which can be minimized with some fade
                audio_bytes = add_fade_in(audio_bytes)
                # Play audio locally on the server by adding audio to the queue
                audio_queue.put(audio_bytes)
            else:
                # Encode the audio data as base64 for frontend playback
                encoded_audio = base64.b64encode(audio_bytes).decode("utf-8")
                await self.session.send_json(
                    json={
                        "audio": encoded_audio,
                        "blenddata": transpose(self.blenddata),
                        "request_id": request.id,
                    }
                )

            start_time = time.time()
            self.blenddata = []
            return start_time, audio_duration

        except Exception as exc:
            logging.exception(f"session {self.session.session_id}, request {request.id}: error in TTS: {exc}")
            traceback.print_exc()
            try:
                await self.session.send_json(json={"finish": "error in TTS", "request_id": request.id})
            except Exception as wsexc:
                logging.exception(f"session {self.session.session_id}, request {request.id}: error in TTS ws: {wsexc}")

    async def no_question(self, request, play_locally=False):
        # send Answer Text to Websocket
        text = no_question_lang_dict[self.session.language]
        await self.session.send_json(
            json={
                "sentence": text,
                "request_id": request.id,
            }
        )
        # speak the text
        await self.speak(text, play_locally)
        # send finish
        await self.session.send_json(
            json={
                "finish": "success",
                "request_id": request.id,
            }
        )

    async def greeting(self, name, request):
        # send Answer Text to Websocket
        text = greeting_lang_dict[self.session.language]
        text = text.replace("()", name)
        # await self.session.send_json(json={"sentence": text})
        # speak the text
        await self.speak(text, request)

    async def play_ping(self):
        file_path = "sources/ping.wav"

        with wave.open(file_path, "rb") as wav_file:
            # Extract audio parameters
            samplerate = wav_file.getframerate()  # Sample rate (24000)
            channels = wav_file.getnchannels()  # Channels (2 for stereo)
            frames = wav_file.readframes(wav_file.getnframes())  # Audio data in bytes

        # Convert the audio data to a numpy array for sounddevice
        data = np.frombuffer(frames, dtype=np.int16)

        # Reshape data for multiple channels if needed
        if channels > 1:
            data = data.reshape(-1, channels)
            data = convert_to_mono(data)

        # Resample if the sample rate doesn't match the playback sample rate (24000 -> 16000)
        if samplerate != SAMPLE_RATE:
            data = resample_audio(data, samplerate, SAMPLE_RATE)

        # Convert the data to bytes and put it in the audio queue
        audio_bytes = data.tobytes()

        # Put the ping sound into the audio queue for playback
        audio_queue.put(audio_bytes)


def resample_audio(data, original_samplerate, target_samplerate):
    if original_samplerate != target_samplerate:
        # Calculate the resampling factor
        resample_factor = target_samplerate / original_samplerate
        # Resample using scipy.signal.resample
        resampled_data = resample(data, int(len(data) * resample_factor))
        return np.int16(resampled_data)
    return data  # No resampling needed if samplerates match


def convert_to_mono(audio_data):
    # Average the channels to convert to mono
    mono_audio = np.mean(audio_data, axis=1).astype(np.int16)
    return mono_audio
