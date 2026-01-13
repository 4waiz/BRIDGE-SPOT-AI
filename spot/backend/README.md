# Spot Voice Server

Backend server for Spot AI voice assistant using Piper TTS with Bryce voice.

## Installation

1. Install Python dependencies:
```bash
cd spot/backend
pip install -r requirements.txt
```

2. Install Piper TTS binary:
   - **Windows**: Download from https://github.com/rhasspy/piper/releases
   - Extract and add to PATH, or place in this directory

   OR install via pip (if available):
```bash
pip install piper-tts
```

## Running the Server

```bash
python voice_server.py
```

The server will start on http://localhost:5000

## API Endpoints

- `POST /tts` - Convert text to speech (returns WAV file)
  - Body: `{"text": "Hello world"}`
  - Returns: WAV audio file

- `POST /tts-base64` - Convert text to speech (returns base64)
  - Body: `{"text": "Hello world"}`
  - Returns: `{"audio": "base64_data", "format": "wav"}`

- `GET /health` - Health check
  - Returns: `{"status": "healthy", "voice": "Bryce"}`

## Usage with Frontend

The frontend voice assistant will automatically connect to this server when it's running. If the server is not available, it will fall back to browser's built-in voices.
