import asyncio

import uvicorn
import dotenv

dotenv.load_dotenv("../config.env")


async def main() -> None:
    # Bind to a non-default port to avoid conflicts with other services.
    config = uvicorn.Config("app:app", host="0.0.0.0", port=4000, log_level="info", reload=True)
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
