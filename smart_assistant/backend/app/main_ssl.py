import asyncio
import logging
import os

import uvicorn

LOGGER = logging.getLogger("uvicorn")
certfile = "../deployment/ssl/server.cert"
keyfile = "../deployment/ssl/server.key"

PORT: int
try:
    PORT = int(os.environ["WEBSITES_PORT"])
except KeyError:
    LOGGER.info("WEBSITES_PORT is not available. Defaulting to port 8000.")
    PORT = 8000


async def main() -> None:
    config = uvicorn.Config("app:app", host="0.0.0.0", port=PORT, log_level="info", ssl_certfile=certfile, ssl_keyfile=keyfile, ws_ping_interval=None, ws_max_size=None)
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
