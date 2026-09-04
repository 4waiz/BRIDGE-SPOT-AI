"""Tiny HTTPS static file server.

Drop-in replacement for `python -m http.server 3001` used to serve the
smart_assistant frontend, but with TLS so the browser lets getUserMedia
and wss:// run when the page is reached over the LAN address. Uses the
same self-signed cert as the FastAPI services.

Usage:
    python https_static_server.py <port> <directory> <cert> <key>
"""

import http.server
import os
import socketserver
import ssl
import sys
import threading


def main(argv: list[str]) -> int:
    if len(argv) != 5:
        print("usage: https_static_server.py <port> <directory> <cert> <key>",
              file=sys.stderr)
        return 2

    port = int(argv[1])
    directory = os.path.abspath(argv[2])
    cert = argv[3]
    key = argv[4]

    if not os.path.isdir(directory):
        print(f"directory not found: {directory}", file=sys.stderr)
        return 2
    if not (os.path.isfile(cert) and os.path.isfile(key)):
        print(f"cert/key missing: {cert} / {key}", file=sys.stderr)
        return 2

    # Threaded so a slow request (say a 30 MB glb over TLS) doesn't stall
    # the next one -- the plain http.server is single-threaded and it shows
    # when a page pulls the twin at the same time as ordinary assets.
    class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
        daemon_threads = True

    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(
        *a, directory=directory, **kw
    )

    server = ThreadedHTTPServer(("0.0.0.0", port), handler)

    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(certfile=cert, keyfile=key)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)

    print(f"HTTPS static server on :{port} serving {directory}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
