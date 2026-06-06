"""Temporary static preview server mirroring app.py mounts. Delete when done."""
import http.server
import os
import socketserver
from urllib.parse import unquote

BASE = os.path.dirname(os.path.abspath(__file__))
FRONTEND = os.path.join(BASE, "frontend")
LATEST = os.path.join(BASE, "data", "latest")
PORT = 4000


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = unquote(path.split("?", 1)[0].split("#", 1)[0])
        if path in ("/", ""):
            return os.path.join(FRONTEND, "index.html")
        if path.startswith("/static/"):
            return os.path.join(FRONTEND, path[len("/static/"):].replace("/", os.sep))
        if path.startswith("/latest/"):
            return os.path.join(LATEST, path[len("/latest/"):].replace("/", os.sep))
        return os.path.join(FRONTEND, path.lstrip("/").replace("/", os.sep))

    def do_GET(self):
        if self.path in ("/", ""):
            self.send_response(302)
            self.send_header("Location", "/static/index.html")
            self.end_headers()
            return
        return super().do_GET()

    def log_message(self, *args):
        pass


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
    print(f"Preview at http://localhost:{PORT}/static/index.html")
    httpd.serve_forever()
