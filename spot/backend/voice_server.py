"""
Voice Server for Spot AI - Uses Piper TTS with Bryce voice
This server provides text-to-speech using the Bryce ONNX voice model
"""

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import subprocess
import os
import tempfile
import base64
from pathlib import Path

app = Flask(__name__)
CORS(app)  # Enable CORS for frontend access

# Path to voice model
VOICE_MODEL_PATH = Path(__file__).parent.parent.parent / "voices" / "en_US-bryce-medium.onnx"
PIPER_EXECUTABLE = "piper"  # Will be installed via pip

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({"status": "healthy", "voice": "Bryce"})

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

        if not text:
            return jsonify({"error": "No text provided"}), 400

        # Check if voice model exists
        if not VOICE_MODEL_PATH.exists():
            return jsonify({
                "error": f"Voice model not found at {VOICE_MODEL_PATH}"
            }), 500

        # Create temporary file for audio output
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as temp_audio:
            output_path = temp_audio.name

        try:
            # Run piper TTS
            cmd = [
                PIPER_EXECUTABLE,
                '--model', str(VOICE_MODEL_PATH),
                '--output_file', output_path
            ]

            # Pass text via stdin
            process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )

            stdout, stderr = process.communicate(input=text)

            if process.returncode != 0:
                print(f"Piper error: {stderr}")
                return jsonify({
                    "error": f"TTS generation failed: {stderr}"
                }), 500

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

        finally:
            # Clean up temporary file after sending
            # Note: Flask will handle the file, we'll clean it in a background task
            pass

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

        if not text:
            return jsonify({"error": "No text provided"}), 400

        # Check if voice model exists
        if not VOICE_MODEL_PATH.exists():
            return jsonify({
                "error": f"Voice model not found at {VOICE_MODEL_PATH}"
            }), 500

        # Create temporary file for audio output
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as temp_audio:
            output_path = temp_audio.name

        try:
            # Run piper TTS
            cmd = [
                PIPER_EXECUTABLE,
                '--model', str(VOICE_MODEL_PATH),
                '--output_file', output_path
            ]

            process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )

            stdout, stderr = process.communicate(input=text)

            if process.returncode != 0:
                print(f"Piper error: {stderr}")
                return jsonify({
                    "error": f"TTS generation failed: {stderr}"
                }), 500

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
    print(f"Voice model exists: {VOICE_MODEL_PATH.exists()}")

    # Start server
    print("Starting Spot Voice Server on http://localhost:5000")
    print("Endpoints:")
    print("  - POST /tts - Text to speech (returns WAV file)")
    print("  - POST /tts-base64 - Text to speech (returns base64 encoded audio)")
    print("  - GET /health - Health check")

    app.run(host='0.0.0.0', port=5000, debug=True)
