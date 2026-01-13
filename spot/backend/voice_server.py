"""
Voice Server for Spot AI - Uses Piper TTS with Bryce voice
This server provides text-to-speech using the Bryce ONNX voice model
"""

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import os
import json
import tempfile
import base64
from pathlib import Path
import urllib.error
import urllib.request
import numpy as np
import soundfile as sf
from piper.voice import PiperVoice

app = Flask(__name__)
CORS(app)  # Enable CORS for frontend access

# Repository root
REPO_ROOT = Path(__file__).resolve().parent.parent.parent

def load_env_file(env_path: Path) -> None:
    if not env_path.exists():
        return
    try:
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except OSError:
        return

load_env_file(REPO_ROOT / ".env")

DEFAULT_OPENAI_MODEL = "gpt-4.1-nano"
DEFAULT_OPENAI_TIMEOUT = 12
DEFAULT_OPENAI_MAX_TOKENS = 200
DEFAULT_SYSTEM_PROMPT = (
    "You are Spot, a concise, friendly voice assistant for a robotics demo. "
    "Keep answers short and practical."
)

OPENAI_API_URL = os.getenv("OPENAI_API_URL", "https://api.openai.com/v1/responses")

# Path to voice model
VOICE_MODEL_PATH = REPO_ROOT / "voices" / "en_US-bryce-medium.onnx"
VOICE_CONFIG_PATH = REPO_ROOT / "voices" / "en_US-bryce-medium.onnx.json"

# Load voice model once at startup for better performance
voice_model = None

def load_voice_model():
    """Load the Piper voice model at startup"""
    global voice_model
    try:
        if VOICE_MODEL_PATH.exists() and VOICE_CONFIG_PATH.exists():
            voice_model = PiperVoice.load(str(VOICE_MODEL_PATH), config_path=str(VOICE_CONFIG_PATH))
            print(f"✓ Voice model loaded successfully: {VOICE_MODEL_PATH}")
            return True
        else:
            print(f"✗ Voice model not found at {VOICE_MODEL_PATH}")
            return False
    except Exception as e:
        print(f"✗ Error loading voice model: {e}")
        return False

def extract_openai_text(payload: dict) -> str:
    if not isinstance(payload, dict):
        return ""
    if isinstance(payload.get("output_text"), str):
        return payload["output_text"].strip()
    output = payload.get("output")
    if isinstance(output, list):
        chunks = []
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content", [])
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict):
                        text = part.get("text")
                        if part.get("type") in ("output_text", "text") and isinstance(text, str):
                            chunks.append(text)
                    elif isinstance(part, str):
                        chunks.append(part)
            elif isinstance(content, str):
                chunks.append(content)
        if chunks:
            return " ".join(chunks).strip()
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message", {})
            if isinstance(message, dict):
                text = message.get("content")
                if isinstance(text, str):
                    return text.strip()
    return ""

def call_openai(prompt: str) -> str:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")

    model = os.getenv("OPENAI_MODEL", DEFAULT_OPENAI_MODEL)
    system_prompt = os.getenv("OPENAI_SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT)
    max_tokens_raw = os.getenv("OPENAI_MAX_TOKENS", str(DEFAULT_OPENAI_MAX_TOKENS))
    timeout_raw = os.getenv("OPENAI_TIMEOUT", str(DEFAULT_OPENAI_TIMEOUT))

    try:
        max_tokens = int(max_tokens_raw)
    except ValueError:
        max_tokens = DEFAULT_OPENAI_MAX_TOKENS

    try:
        timeout = float(timeout_raw)
    except ValueError:
        timeout = DEFAULT_OPENAI_TIMEOUT

    payload = {
        "model": model,
        "input": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        "max_output_tokens": max_tokens,
    }

    request_data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        OPENAI_API_URL,
        data=request_data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )

    with urllib.request.urlopen(req, timeout=timeout) as response:
        response_payload = json.load(response)

    answer = extract_openai_text(response_payload)
    if not answer:
        raise RuntimeError("OpenAI returned an empty response")
    return answer

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({"status": "healthy", "voice": "Bryce"})

@app.route('/chat', methods=['POST'])
def chat():
    """Chat endpoint backed by OpenAI, with the frontend providing fallback."""
    try:
        data = request.json or {}
        text = data.get("text") or data.get("query") or data.get("message") or ""

        if not str(text).strip():
            return jsonify({"error": "No text provided"}), 400

        answer = call_openai(str(text).strip())
        return jsonify({"answer": answer, "source": "openai"})

    except urllib.error.HTTPError as exc:
        try:
            details = exc.read().decode("utf-8", errors="ignore")
        except Exception:
            details = ""
        print(f"OpenAI HTTP error: {exc.code} {details}")
        return jsonify({"error": "OpenAI request failed"}), 502
    except RuntimeError as exc:
        print(f"OpenAI unavailable: {exc}")
        return jsonify({"error": str(exc)}), 503
    except Exception as exc:
        print(f"OpenAI error: {exc}")
        return jsonify({"error": "OpenAI request failed"}), 500

@app.route('/tts', methods=['POST'])
def text_to_speech():
    """
    Convert text to speech using Bryce voice
    Expected JSON: {"text": "text to speak"}
    Returns: Audio file (WAV format)
    """
    try:
        data = request.json
        text = data.get('text', '')

        if not text.strip():
            return jsonify({"error": "No text provided"}), 400

        # Check if voice model is loaded
        if voice_model is None:
            return jsonify({
                "error": "Voice model not loaded. Please restart the server."
            }), 500

        # Create temporary file for audio output
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as temp_audio:
            output_path = temp_audio.name

        try:
            # Generate speech using Piper library
            with sf.SoundFile(output_path, 'w', samplerate=voice_model.config.sample_rate,
                            channels=1, subtype='PCM_16') as wav_file:
                for audio_chunk in voice_model.synthesize(text):
                    audio_bytes = audio_chunk.audio_int16_bytes
                    int_array = np.frombuffer(audio_bytes, dtype=np.int16)
                    wav_file.write(int_array)

            # Check if audio file was created
            if not os.path.exists(output_path):
                return jsonify({"error": "Audio file not generated"}), 500

            # Return the audio file
            return send_file(
                output_path,
                mimetype='audio/wav',
                as_attachment=False,
                download_name='speech.wav'
            )

        except Exception as e:
            # Clean up on error
            if os.path.exists(output_path):
                os.unlink(output_path)
            raise

    except Exception as e:
        print(f"Error in TTS: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/tts-base64', methods=['POST'])
def text_to_speech_base64():
    """
    Convert text to speech and return as base64-encoded audio
    This is useful for direct playback in the browser
    """
    try:
        data = request.json
        text = data.get('text', '')

        if not text.strip():
            return jsonify({"error": "No text provided"}), 400

        # Check if voice model is loaded
        if voice_model is None:
            return jsonify({
                "error": "Voice model not loaded. Please restart the server."
            }), 500

        # Create temporary file for audio output
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as temp_audio:
            output_path = temp_audio.name

        try:
            # Generate speech using Piper library
            with sf.SoundFile(output_path, 'w', samplerate=voice_model.config.sample_rate,
                            channels=1, subtype='PCM_16') as wav_file:
                for audio_chunk in voice_model.synthesize(text):
                    audio_bytes = audio_chunk.audio_int16_bytes
                    int_array = np.frombuffer(audio_bytes, dtype=np.int16)
                    wav_file.write(int_array)

            # Read audio file and encode as base64
            with open(output_path, 'rb') as audio_file:
                audio_data = audio_file.read()
                audio_base64 = base64.b64encode(audio_data).decode('utf-8')

            # Clean up
            os.unlink(output_path)

            return jsonify({
                "audio": audio_base64,
                "format": "wav"
            })

        except Exception as e:
            # Clean up on error
            if os.path.exists(output_path):
                os.unlink(output_path)
            raise

    except Exception as e:
        print(f"Error in TTS: {str(e)}")
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    print(f"Voice model path: {VOICE_MODEL_PATH}")
    print(f"Config path: {VOICE_CONFIG_PATH}")
    print(f"Voice model exists: {VOICE_MODEL_PATH.exists()}")
    print(f"Config exists: {VOICE_CONFIG_PATH.exists()}")
    print()

    # Load voice model at startup
    print("Loading Bryce voice model...")
    if load_voice_model():
        print("✓ Voice model loaded successfully")
    else:
        print("✗ Failed to load voice model - server will return errors")
    print()

    # Start server
    print("Starting Spot Voice Server on http://localhost:5000")
    print("Endpoints:")
    print("  - POST /tts - Text to speech (returns WAV file)")
    print("  - POST /tts-base64 - Text to speech (returns base64 encoded audio)")
    print("  - GET /health - Health check")
    print()

    app.run(host='0.0.0.0', port=5000, debug=True)
