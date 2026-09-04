import asyncio
import os

import uvicorn
import dotenv

dotenv.load_dotenv("../config.env")


# Self-signed cert covering localhost + this machine's LAN IP. Serving TLS
# lets the browser treat the wifi URL as a secure origin, which is what
# getUserMedia (Voice Control, home mic bubble) requires. Regenerate with
# scripts/generate_lan_cert.py if the wifi IP changes.
_SSL_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "deployment", "ssl"))
_SSL_CERT = os.path.join(_SSL_DIR, "server.crt")
_SSL_KEY = os.path.join(_SSL_DIR, "server.key")


async def main() -> None:
    # Bind to a non-default port to avoid conflicts with other services.
    # "warning" keeps the console to the service URL and real problems. Set
    # SPOT_LOG_LEVEL=info in config.env when debugging request flow.
    log_level = os.getenv("SPOT_LOG_LEVEL", "warning")
    kwargs = dict(host="0.0.0.0", port=4000, log_level=log_level, reload=True)
    if os.path.isfile(_SSL_CERT) and os.path.isfile(_SSL_KEY):
        kwargs["ssl_certfile"] = _SSL_CERT
        kwargs["ssl_keyfile"] = _SSL_KEY
    config = uvicorn.Config("app:app", **kwargs)
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
