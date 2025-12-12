import asyncio
import logging
import os
import sys
import subprocess
import uvicorn

LOGGER = logging.getLogger("uvicorn")

try:
    import sentence_transformers  # noqa: F401
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "sentence-transformers"])
    subprocess.check_call([sys.executable, "-m", "pip", "install", "openai-whisper"])

PORT: int
try:
    PORT = int(os.environ["WEBSITES_PORT"])
except KeyError:
    LOGGER.info("WEBSITES_PORT is not available. Defaulting to port 8000.")
    PORT = 8000


async def main() -> None:
    config = uvicorn.Config("app:app", host="0.0.0.0", port=PORT, log_level="info", ws_ping_interval=None, ws_max_size=None)
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
