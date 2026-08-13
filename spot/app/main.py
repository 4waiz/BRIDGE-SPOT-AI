import asyncio
import os

import uvicorn
import dotenv

dotenv.load_dotenv("../config.env")


async def main() -> None:
    # Bind to a non-default port to avoid conflicts with other services.
    # "warning" keeps the console to the service URL and real problems. Set
    # SPOT_LOG_LEVEL=info in config.env when debugging request flow.
    log_level = os.getenv("SPOT_LOG_LEVEL", "warning")
    config = uvicorn.Config("app:app", host="0.0.0.0", port=4000, log_level=log_level, reload=True)
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
