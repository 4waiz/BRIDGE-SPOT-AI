# BRIDGE Spot AI

BRIDGE Spot AI is a multi-service system for Boston Dynamics Spot demos and facility inspection. It combines:
- a Spot inspection API + web UI that downloads mission images from Spot, runs CV models, and serves annotated results (`spot/app/app.py`, `spot/app/digital_factory.py`, `spot/app/hsse.py`, `spot/frontend/*`).
- a Smart Assistant WebSocket backend and static frontend (`smart_assistant/backend/app/app.py`, `smart_assistant/frontend/static/index.html`).
- a voice backend for the Spot UI that provides chat/STT/TTS via OpenAI (`spot/backend/voice_server.py`, `spot/frontend/voice_assistant_simple.js`).

## Services and ports

| Service | Description | Entrypoint | Port |
| --- | --- | --- | --- |
| Spot inspection API | FastAPI app that serves Spot UI + analysis endpoints | `spot/app/main.py` (runs `app` from `spot/app/app.py`) | 4000 |
| Smart Assistant backend | FastAPI WebSocket backend for avatar assistant | `smart_assistant/backend/app/main_lif.py` (serves `app` from `smart_assistant/backend/app/app.py`) | 4001 |
| Smart Assistant static UI | Static site server for the avatar assistant | `scripts/start_frontend.ps1` (Python `http.server`) | 3001 |
| Spot voice backend | Flask API for chat/STT/TTS | `spot/backend/voice_server.py` | 5000 |

Port references: `spot/app/main.py`, `smart_assistant/backend/app/main_lif.py`, `scripts/start_frontend.ps1`, `spot/backend/voice_server.py`.

## Quick start (Windows-first)

1. Install Python 3.11 or 3.12 (the start scripts validate this): `scripts/start_spot.ps1`, `scripts/start_assistant.ps1`, `scripts/start_frontend.ps1`, `scripts/start_voice.ps1`.
2. Install Node.js (used only to run `npm start` with `concurrently`): `package.json`.
3. Configure environment variables (see `docs/configuration.md`). At minimum, set `OPENAI_API_KEY` for OpenAI calls in:
   - `smart_assistant/backend/app/user_session.py`
   - `spot/backend/voice_server.py`
4. Install Node dependencies:

```bash
npm install
```

5. Start all services:

```bash
npm start
```

Or start them individually:

```bash
npm run start:spot
npm run start:assistant
npm run start:frontend
npm run start:voice
```

The PowerShell scripts create virtual environments and install Python dependencies automatically.

## Repo layout (high level)

- `spot/`: Spot inspection API, models, data, and frontend UI (`spot/app/*`, `spot/frontend/*`, `spot/data/*`).
- `smart_assistant/`: Avatar-based Smart Assistant backend + static frontend (`smart_assistant/backend/*`, `smart_assistant/frontend/*`).
- `spot/backend/`: Voice backend (Flask) for the Spot UI (`spot/backend/voice_server.py`).
- `scripts/`: PowerShell startup scripts that bootstrap Python venvs and launch services.
- `spot-sdk-4.1.1/`: Boston Dynamics Spot SDK vendor drop (used by `spot/app/data_acquisition_download.py`).
- `spot_legacy/`: Legacy Spot stack (not wired into current start scripts).
- `voices/`, `voskModels/`: Local voice model assets.

## Documentation

- `docs/architecture.md`
- `docs/getting-started.md`
- `docs/configuration.md`
- `docs/development.md`
- `docs/deployment.md`
- `docs/api.md`
- `docs/troubleshooting.md`
- `CONTRIBUTING.md`
- `CHANGELOG.md`

## Known TODOs / gaps (from repo scan)

- `spot/app/main.py` and `spot/app/spot_file_copy.py` load `../config.env`. The file is gitignored; copy `spot/config.env.example` to `spot/config.env` to create it.
- `smart_assistant/backend/app/main_ssl.py` references `../deployment/ssl/server.cert` and `../deployment/ssl/server.key`, but `smart_assistant/backend/deployment/ssl` is missing. TODO: add SSL assets or update paths.
- No CI/CD config found (no `.github/workflows` or similar). TODO: define pipeline if needed.
- Tests live in `spot/tests/` and run with `pytest` from the repository root (config in `pytest.ini`). They need no robot — the bosdyn service clients are mocked — and cover the control gating, speed clamping, docking behaviour, dance envelopes and a set of source-level safety invariants. Install the extras first: `spot/deployment/requirements/requirements-dev.txt`.
- Spot robot IP is still hard-coded in `spot_legacy/app/*/config.py` and `spot/training/spot_cam_4.1.1/trainingdata.py`. The live inspection path (`spot/app/spot_file_copy.py`) now reads `SPOT_IP` from `spot/config.env`.
