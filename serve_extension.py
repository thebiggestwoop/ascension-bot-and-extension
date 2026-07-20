"""Local static file server for the Owlbear extension, with a permissive CORS
header on every response.

Owlbear Rodeo's own page (a different origin than wherever this serves from)
fetches manifest.json to validate it before letting you install the
extension, and the popover's own page fetches app.js/style.css/icon.svg --
all cross-origin requests. Plain http.server sets no CORS headers, so the
browser blocks those fetches. WitchDice's own hosting config does the same
"Access-Control-Allow-Origin: *" for this exact reason.
"""

import http.server
import os
import sys

DEFAULT_PORT = 5500
DIRECTORY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs")


class CORSRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    http.server.test(HandlerClass=CORSRequestHandler, port=port)
