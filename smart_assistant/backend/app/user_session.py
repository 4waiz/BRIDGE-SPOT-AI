import array
import logging
import math
import os
import queue
import wave

from openai import OpenAI

try:
    import sounddevice as sd
except OSError:
    print("No server side audio possible - no sound card available.")

import asyncio
import time
from collections import deque

import connectors.gpt_api as gpt_api
import connectors.speech_to_text as speech_to_text
import connectors.text_to_speech as text_to_speech
import numpy as np
try:
    import onnxruntime as ort  # Added for Silero VAD
except Exception:
    ort = None
try:
    import openwakeword
except Exception:
    openwakeword = None

user_session_queue = queue.Queue(100)
request_queue = queue.Queue(500)

# Silero VAD parameters
VAD_MODEL_PATH = "../../frontend/static/js/silero_vad.onnx"
SAMPLE_RATE = 16000
CHUNK_SIZE = int(SAMPLE_RATE * 0.1)  # 100ms chunks
PRE_ACTIVATION_DURATION = 0.5  # Duration of audio to keep before activation (seconds)
MINIMUM_DURATION = 4.0  # Minimum duration of recording (seconds)
SILENCE_DURATION = 2.0  # Duration of silence to stop recording
PRE_ACTIVATION_CHUNKS = int(PRE_ACTIVATION_DURATION * SAMPLE_RATE // CHUNK_SIZE)
MINIMUM_CHUNKS = int(MINIMUM_DURATION * SAMPLE_RATE // CHUNK_SIZE)
WWD_THRESHOLD = 0.003  # Threshold for wake-word-detection (0.5 baseline seems a little high)
WWD_TIMEOUT = 600  # Timeout for wake-word-detection in seconds
WWD_MODEL_PATH = "./sources/hey_spot.onnx"  # Path to the OpenWakeWord model
SERVER_VAD_PROBABILITY = 0.5
EMPTY_WWD_BUFFER = np.zeros(CHUNK_SIZE * 15, dtype=np.int16)  # 1.5 seconds
NO_SPEECH_TIMEOUT = 10  # Timeout after going back to WWD

# Global variables for WWD
is_server_wwd_running = False
wwd_rolling_buffer = None
ping_data = None
ping_samplerate = None

# Initialize states for Silero VAD
h_state = np.zeros((2, 1, 64), dtype=np.float32)
c_state = np.zeros((2, 1, 64), dtype=np.float32)

# Initialize Silero VAD
onnx_session = None
if ort is not None:
    try:
        onnx_session = ort.InferenceSession(VAD_MODEL_PATH)
    except Exception as exc:
        logging.warning("Silero VAD disabled (onnxruntime init failed): %s", exc)


# Voice Activity Detection function
def is_speech(chunk, sample_rate):
    """
    Check if the given audio chunk contains speech using Silero VAD.
    :param chunk: The audio data (numpy array of shape [samples])
    :param sample_rate: The sample rate of the audio
    :return: Boolean indicating if speech is detected
    """
    if onnx_session is None:
        return False
    global h_state, c_state

    # Convert audio to float32 and normalize to [-1, 1]
    max_val = np.iinfo(chunk.dtype).max if chunk.dtype.kind in ["i", "u"] else 1.0
    audio = chunk.astype(np.float32) / max_val  # Normalize

    # Scale up the signal if it's too quiet
    audio = audio * 10  # Amplify the signal
    audio = np.clip(audio, -1.0, 1.0)  # Ensure it stays in [-1, 1]

    # Prepare the input tensor for ONNX
    input_data = np.expand_dims(audio, axis=0)  # Add batch dimension
    input_sample_rate = np.array([sample_rate], dtype=np.int64)

    # Run inference with ONNX model
    outputs = onnx_session.run(
        None,
        {
            "input": input_data,
            "sr": input_sample_rate,
            "h": h_state,
            "c": c_state,
        },
    )

    # Extract outputs
    speech_prob = outputs[0][0][0]  # Probability of speech presence
    h_state, c_state = outputs[1], outputs[2]  # Update recurrent states

    # Return True if speech probability exceeds threshold
    return speech_prob > SERVER_VAD_PROBABILITY


# class to manage requests and cancel specifically
class Request:
    def __init__(self, id, session):
        self.id = id
        self.cancel = False
        self.session = session
        request_queue.put(self)

    async def handle_request(self, data, greeting=False, question="", use_server_wwd=False, server_audio=False, client_audio=False):
        play_locally = False
        ww_detected = False

        if question:
            logging.info(f"session {self.session.session_id}, request {self.id}: question sent as text: {data['question']}")

        if greeting:
            await self.session.tts_module.greeting(data["greeting"], self)
            return

        # This is the main logic of the program
        if not question:
            if use_server_wwd:
                ww_detected = await self.server_wwd()
                server_audio = True
                if not ww_detected:
                    return False
            if server_audio:
                audio = await self.server_audio()
                if audio is None:
                    return True
                play_locally = True
            elif client_audio:
                audio = await self.client_audio(data)
            else:  # This case shouldn't happen
                return
            audio_file = await self.handle_audio(audio)
            question = await self.session.stt_module.recognize_audio(audio_file, self)
            await self.handle_audio_cleanup(audio_file)
        if not self.cancel:
            if not question:
                logging.info(f"session {self.session.session_id}: No question detected")
                await self.session.tts_module.no_question(self, play_locally)
            else:
                await self.session.gpt_connector.question(question, self, play_locally)

        if ww_detected:
            return True

    async def handle_wwd_request(self, data):
        global is_server_wwd_running
        if is_server_wwd_running:
            return
        is_server_wwd_running = True
        while True:
            restart = await self.handle_request(data, use_server_wwd=True)
            if not restart:
                is_server_wwd_running = False
                break

    # Client side audio recording
    async def client_audio(self, data):
        audio = data["client_audio"][1:-1].split(",")
        return audio

    # Server side audio recording
    async def server_audio(self):
        # Queue for storing audio data
        audio_queue = queue.Queue()

        # Callback function to capture audio input in chunks
        def audio_callback(indata, _frames, _time, status):
            if status:
                print(status)
            audio_queue.put(indata.copy())

        # Buffers for pre-activation and recording
        pre_activation_buffer = deque(maxlen=PRE_ACTIVATION_CHUNKS)
        recorded_data = []
        speech_active = False
        silence_start_time = None
        recording_active = True
        start_time = time.time()
        logging.info("Listening started.")

        # Start recording stream
        with text_to_speech.server_audio_lock:
            with sd.InputStream(samplerate=SAMPLE_RATE, blocksize=CHUNK_SIZE, channels=1, callback=audio_callback):
                while recording_active:
                    # Get audio chunk from the queue
                    chunk = audio_queue.get()
                    pre_activation_buffer.append(chunk)

                    # Wenn nach 10 Sekunden keine Sprache erkannt wurde, beenden
                    if not speech_active and time.time() - start_time > NO_SPEECH_TIMEOUT:
                        logging.info(f"No speech detected for {NO_SPEECH_TIMEOUT}s, stopping.")
                        return None

                    # Sprache erkennen
                    if not speech_active and is_speech(chunk.flatten(), SAMPLE_RATE):
                        speech_active = True
                        logging.info("Speech detected, recording started.")
                        recorded_data.extend(pre_activation_buffer)

                    # If speech is active, continue recording
                    if speech_active:
                        recorded_data.append(chunk)

                        # Check for silence to stop recording
                        if not is_speech(chunk.flatten(), SAMPLE_RATE):
                            if silence_start_time is None:
                                silence_start_time = time.time()
                            elif time.time() - silence_start_time > SILENCE_DURATION:
                                # Stop recording after prolonged silence
                                if len(recorded_data) >= MINIMUM_CHUNKS:
                                    recording_active = False
                                else:
                                    logging.info("Recording too short, waiting for more speech.")
                                    silence_start_time = None  # Reset silence timer
                        else:
                            silence_start_time = None  # Reset silence timer if speech resumes

            # Combine recorded chunks into a single array
            audio = np.concatenate(recorded_data, axis=0)
            logging.info("Recording and Listening stopped.")
            self.play_ping()
        return audio

    async def handle_audio(self, audio):
        # wave file needs signed integers, which range from -(2**31-2) to 2**31-1. Both 2**31 and -(2**31-1) cause error
        audio = array.array("i", [math.floor(float(x) * (2**31 - 1)) if float(x) > 0 else math.floor(float(x) * (2**31 - 2)) for x in audio])

        audio_file = f"audio_{self.session.session_id}.wav"
        with wave.open(audio_file, "wb") as wav_file:
            # Set the audio parameters, see frontend VAD
            sample_width = 4  # 32-bit audio
            sample_rate = 16000  # 16 kHz
            num_channels = 1  # Mono audio
            wav_file.setsampwidth(sample_width)
            wav_file.setframerate(sample_rate)
            wav_file.setnchannels(num_channels)
            wav_file.writeframes(audio.tobytes())

        return audio_file

    async def handle_audio_cleanup(self, audio_file):
        # Delete temporary audio file
        try:
            os.remove(audio_file)
        except FileNotFoundError:
            pass

    async def server_wwd(self):
        # Ensure models are downloaded (uses buffered models if available)
        if openwakeword is None or ort is None:
            logging.warning("Wake word detection disabled (missing openwakeword/onnxruntime).")
            return
        openwakeword.utils.download_models()
        # Initialize OpenWakeWord with a pre-trained model
        oww_model = openwakeword.Model(
            wakeword_models=[WWD_MODEL_PATH],
            inference_framework="onnx",
            # enable_speex_noise_suppression=True,  # Enable Speex noise suppression, import needed
            # vad_threshold=0.1  # Set VAD threshold
        )
        wakeword_detected = False  # Flag to indicate detection
        global wwd_rolling_buffer
        wwd_rolling_buffer = EMPTY_WWD_BUFFER

        def audio_callback(indata, _frames, _time, status=None):
            global wwd_rolling_buffer
            nonlocal wakeword_detected
            if status:
                print(f"Audio status: {status}")
            if wakeword_detected:  # Stop processing if wake word was detected
                return

            # Process audio input
            new_audio = indata[:, 0].astype(np.int16)  # Convert to 1D array

            # Shift buffer left and add new block at the end
            wwd_rolling_buffer = np.roll(wwd_rolling_buffer, -CHUNK_SIZE)
            wwd_rolling_buffer[-CHUNK_SIZE:] = new_audio

            # Execute wake word detection on rolling buffer
            prediction = oww_model.predict(wwd_rolling_buffer)

            # Process result
            for wakeword in prediction:
                score = prediction[wakeword]
                print(f"Score for {wakeword}: {round(score, 8)}")  # Show score
                if score > WWD_THRESHOLD:  # Threshold for wake word detection
                    logging.info("Wake word detected!")
                    # Empty playback queue
                    while not text_to_speech.audio_queue.empty():
                        try:
                            text_to_speech.audio_queue.get_nowait()  # Non-blocking, raises `queue.Empty` if queue is empty
                        except queue.Empty:
                            break
                    # Wakeword detected
                    wakeword_detected = True

        try:
            with text_to_speech.server_audio_lock:
                logging.info(f"Listening for wake word for {round(WWD_TIMEOUT / 60)} minutes...")
                with sd.InputStream(channels=1, samplerate=SAMPLE_RATE, blocksize=CHUNK_SIZE, dtype="int16", callback=audio_callback):
                    # Wait for 10 minutes or until the wake word is detected
                    timeout = WWD_TIMEOUT
                    start_time = asyncio.get_event_loop().time()
                    while asyncio.get_event_loop().time() - start_time < timeout:
                        if wakeword_detected:
                            self.play_ping()
                            return True
                        await asyncio.sleep(0.01)  # Non-blocking sleep
                logging.info("Timeout reached. No wake word detected.")
            return False
        finally:
            logging.info("Stopped listening for wake word.")

    def play_ping(self):
        global ping_data
        global ping_samplerate
        if ping_data is None or ping_samplerate is None:
            # Path to your .wav file
            file_path = "sources/ping.wav"

            # Open the .wav file
            with wave.open(file_path, "rb") as wav_file:
                # Extract audio parameters
                ping_samplerate = wav_file.getframerate()
                channels = wav_file.getnchannels()
                frames = wav_file.readframes(wav_file.getnframes())

            # Convert the audio data to a numpy array for sounddevice
            ping_data = np.frombuffer(frames, dtype=np.int16)

            # Reshape data for multiple channels
            if channels > 1:
                ping_data = ping_data.reshape(-1, channels)

        # Play the audio
        sd.play(ping_data, ping_samplerate)


def get_request(id):
    for request in list(request_queue.queue):
        if request.id == id:
            return request
    return None


class UserSession:
    def __init__(self, session_id, websocket):
        self.session_id = session_id

        # Websocket
        self.websocket = websocket

        # Language defined in settings
        self.language = "multilingual"

        # OpenAI client to make requests to STT and GPT
        api_key = os.getenv("OPENAI_API_KEY")
        if api_key:
            try:
                self.client = OpenAI(api_key=api_key)
            except Exception as exc:
                logging.warning("OpenAI client disabled (invalid API key): %s", exc)
                self.client = None
        else:
            logging.warning("OpenAI client disabled (OPENAI_API_KEY not set).")
            self.client = None

        # Init GPT-API connector
        self.gpt_connector = gpt_api.GPT_Chat(user_session=self)

        # Init Text to speech module
        self.tts_module = text_to_speech.TextToSpeechModule(user_session=self)

        # setting for testing different STT models
        self.stt_module = speech_to_text.SpeechToTextModule(user_session=self)

        user_session_queue.put(self)

    # Catch errors occuring with server side audio without frontend
    async def send_json(self, json):
        try:
            await self.websocket.send_json(data=json)
        except Exception as e:
            logging.error("Error sending via websocket: %s", e)


def get_user_session(session_id, websocket):
    user_session = search_user_session_by_id(session_id)
    if user_session:
        # Update websocket in user session
        user_session.websocket = websocket
    else:
        # Create new user session
        user_session = UserSession(session_id, websocket)
    return user_session


def search_user_session_by_id(session_id):
    for user_session in list(user_session_queue.queue):
        if user_session.session_id == session_id:
            return user_session
    return None


def search_user_session_by_ws(websocket):
    for user_session in list(user_session_queue.queue):
        if user_session.websocket == websocket:
            return user_session
    return None
