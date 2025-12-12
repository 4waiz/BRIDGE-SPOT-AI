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
    subprocess.check_call([sys.executable, "-m", "pip", "install", "sentence-transformers"])
    subprocess.check_call([sys.executable, "-m", "pip", "install", "openai-whisper"])

# Load environment variables
load_dotenv()


async def main() -> None:
    config = uvicorn.Config("app:app", host="0.0.0.0", port=PORT, log_level="info", ws_ping_interval=None, ws_max_size=None)
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
