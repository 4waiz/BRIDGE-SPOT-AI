"""
Voice Server for Spot AI - OpenAI-backed chat, STT, and TTS.
"""

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from openai import OpenAI
import os
import json
import base64
import tempfile
from pathlib import Path
import urllib.error
import urllib.request
import io

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
OPENAI_TTS_MODEL = os.getenv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts")
OPENAI_TTS_VOICE = os.getenv("OPENAI_TTS_VOICE", "onyx")
OPENAI_STT_MODEL = os.getenv("OPENAI_STT_MODEL", "gpt-4o-mini-transcribe")


def get_openai_client() -> OpenAI:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    return OpenAI(api_key=api_key)


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


def extract_audio_bytes(response) -> bytes:
    if hasattr(response, "read"):
        return response.read()
    if hasattr(response, "content"):
        return response.content
    if hasattr(response, "data"):
        return response.data
    raise RuntimeError("Unsupported OpenAI TTS response type")


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
    return jsonify({"status": "healthy", "tts": "openai", "stt": "openai"})


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
    Convert text to speech using OpenAI TTS
    Expected JSON: {"text": "text to speak"}
    Returns: Audio file (WAV format)
    """
    try:
        data = request.json or {}
        text = data.get('text', '')

        if not text.strip():
            return jsonify({"error": "No text provided"}), 400

        client = get_openai_client()
        response = client.audio.speech.create(
            model=OPENAI_TTS_MODEL,
            voice=OPENAI_TTS_VOICE,
            input=text,
            response_format="wav",
        )
        audio_bytes = extract_audio_bytes(response)
        return send_file(
            io.BytesIO(audio_bytes),
            mimetype='audio/wav',
            as_attachment=False,
            download_name='speech.wav'
        )

    except Exception as e:
        print(f"Error in TTS: {str(e)}")
        return jsonify({"error": str(e)}), 500


@app.route('/tts-base64', methods=['POST'])
def text_to_speech_base64():
    """
    Convert text to speech and return as base64-encoded audio.
    """
    try:
        data = request.json or {}
        text = data.get('text', '')

        if not text.strip():
            return jsonify({"error": "No text provided"}), 400

        client = get_openai_client()
        response = client.audio.speech.create(
            model=OPENAI_TTS_MODEL,
            voice=OPENAI_TTS_VOICE,
            input=text,
            response_format="wav",
        )
        audio_bytes = extract_audio_bytes(response)
        audio_base64 = base64.b64encode(audio_bytes).decode('utf-8')
        return jsonify({
            "audio": audio_base64,
            "format": "wav"
        })

    except Exception as e:
        print(f"Error in TTS: {str(e)}")
        return jsonify({"error": str(e)}), 500


@app.route('/stt', methods=['POST'])
def speech_to_text():
    """
    Convert speech to text using OpenAI STT.
    Accepts multipart form-data with an audio file.
    """
    try:
        audio_file = request.files.get("audio") or request.files.get("file")
        if audio_file is None:
            return jsonify({"error": "No audio file provided"}), 400

        language = (request.form.get("language") or "").strip()
        client = get_openai_client()
        suffix = os.path.splitext(audio_file.filename or "")[1] or ".webm"
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_audio:
                temp_path = temp_audio.name
                audio_file.save(temp_audio)
            with open(temp_path, "rb") as handle:
                if language:
                    result = client.audio.transcriptions.create(
                        model=OPENAI_STT_MODEL,
                        file=handle,
                        language=language,
                    )
                else:
                    result = client.audio.transcriptions.create(
                        model=OPENAI_STT_MODEL,
                        file=handle,
                    )
        finally:
            if temp_path and os.path.exists(temp_path):
                os.unlink(temp_path)
        text = result.text.strip() if result and result.text else ""
        if not text:
            return jsonify({"text": "", "no_speech": True})
        return jsonify({"text": text})
    except Exception as exc:
        print(f"Error in STT: {str(exc)}")
        return jsonify({"error": str(exc)}), 500


if __name__ == '__main__':
    # Start server
    print("Starting Spot Voice Server on http://localhost:5000")
    print("Endpoints:")
    print("  - POST /chat - Text chat with OpenAI")
    print("  - POST /tts - Text to speech (returns WAV file)")
    print("  - POST /tts-base64 - Text to speech (returns base64 encoded audio)")
    print("  - POST /stt - Speech to text (returns transcription)")
    print("  - GET /health - Health check")
    print()

    app.run(host='0.0.0.0', port=5000, debug=True)
