# STEP 2: press ENTER on the highlighted formula and confirm the
# "NUMBER OF BATCHES" screen opens. Arrow keys are not part of this step.
import json
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen

UPSTREAM = "http://localhost:3001"
current = [0.0]


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _proxy(self):
        try:
            with urlopen(UPSTREAM + self.path) as r:
                body = r.read()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        except Exception:
            self.send_response(502)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/api/"):
            if self.path.startswith("/api/scale/stream"):
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(b"retry: 500\n\n")
                status = json.dumps(
                    {"status": "connected", "port": "MOCK", "baudRate": 9600, "message": None, "bytesReceived": 0}
                )
                self.wfile.write(f"event: status\ndata: {status}\n\n".encode())
                self.wfile.flush()
                try:
                    while True:
                        payload = json.dumps(
                            {"weight": current[0], "receivedAt": datetime.now().isoformat(timespec="milliseconds")}
                        )
                        self.wfile.write(f"event: reading\ndata: {payload}\n\n".encode())
                        self.wfile.flush()
                        time.sleep(0.3)
                except Exception:
                    pass
            else:
                self._proxy()
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 3999), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()

from playwright.sync_api import sync_playwright

try:
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(viewport={"width": 1080, "height": 1920})
        ctx.add_init_script("localStorage.setItem('reem.serverUrl','http://localhost:3999')")
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto("http://localhost:3001/staff/", wait_until="networkidle")

        # Highlight the second formula first, so Enter picks a real choice.
        page.wait_for_selector(".staff-row.kb-active", timeout=15000)
        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(300)
        picked = (page.locator(".staff-row.kb-active .staff-row-name").text_content() or "").strip()
        print("highlighted:", picked)

        # ENTER on the keypad must open the batch-count step.
        page.keyboard.press("Enter")
        page.wait_for_selector(".staff-batch-card", timeout=5000)
        title = (page.locator(".staff-batch-card .screen-title").text_content() or "").strip()
        formula = (page.locator(".staff-batch-formula").text_content() or "").strip()
        page.screenshot(path="D:/REMAN Projects/kb_enter_open.png")

        print("screen after ENTER:", title, "| formula:", formula)
        print("JS errors:", errors or "none")
        ok = title == "NUMBER OF BATCHES" and formula == picked
        print("ENTER TEST:", "PASSED" if ok else "FAILED")
        b.close()
finally:
    server.shutdown()
