import asyncio
import logging
from dotenv import load_dotenv
import os
import sys
import subprocess
import uvicorn

LOGGER = logging.getLogger("uvicorn")
PORT: int = 4001

try:
    import sentence_transformers  # noqa: F401
except ImportError:
    # Pinned: transformers 5.x / sentence-transformers 4+ require torch>=2.4,
    # but this environment runs the CPU torch 2.3.1 build.
    subprocess.check_call([sys.executable, "-m", "pip", "install", "transformers==4.44.2", "sentence-transformers==3.0.1"])
    subprocess.check_call([sys.executable, "-m", "pip", "install", "openai-whisper"])

# Load environment variables
load_dotenv()


_SSL_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "deployment", "ssl"))
_SSL_CERT = os.path.join(_SSL_DIR, "server.crt")
_SSL_KEY = os.path.join(_SSL_DIR, "server.key")


async def main() -> None:
    # HTTPS so the browser lets getUserMedia + wss:// run on the LAN URL.
    # Shared self-signed cert lives at <repo>/deployment/ssl/; the frontend
    # WebSocket already auto-upgrades to wss:// on a secure origin.
    kwargs = dict(host="0.0.0.0", port=PORT, log_level="info", ws_ping_interval=None, ws_max_size=None)
    if os.path.isfile(_SSL_CERT) and os.path.isfile(_SSL_KEY):
        kwargs["ssl_certfile"] = _SSL_CERT
        kwargs["ssl_keyfile"] = _SSL_KEY
    config = uvicorn.Config("app:app", **kwargs)
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
