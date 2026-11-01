# STEP 3: the NUMBER OF BATCHES screen — the count is typable AND the arrows
# work. Type 12, check it clamps junk, then ArrowDown adjusts, then ENTER
# starts the weighing. Mouse is never used after the formula row click.
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

        page.wait_for_selector(".staff-row.kb-active", timeout=15000)
        page.keyboard.press("ArrowDown")   # highlight Layer 2
        page.wait_for_timeout(300)
        page.keyboard.press("Enter")       # open NUMBER OF BATCHES
        page.wait_for_selector(".staff-batch-card", timeout=5000)

        # -- the exact scenario: default is 1, typing 25 replaces it ----------
        page.keyboard.type("25", delay=80)
        page.wait_for_timeout(200)
        typed = (page.locator("#t-batch-input").input_value() or "").strip()
        note = (page.locator(".staff-batch-note").text_content() or "").strip()
        print(f"typed '25' over default '1' -> value: {typed} | note: {note}")

        # -- arrows still work around the typed value: 25 -> 26 -> 25 ---------
        page.keyboard.press("ArrowUp")
        page.wait_for_timeout(200)
        up = (page.locator("#t-batch-input").input_value() or "").strip()
        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(200)
        down = (page.locator("#t-batch-input").input_value() or "").strip()
        print(f"ArrowUp -> {up} | ArrowDown -> {down}")

        # -- typing replaces again even after the arrows: 25 -> 7 -------------
        page.keyboard.type("7", delay=80)
        page.wait_for_timeout(200)
        replaced = (page.locator("#t-batch-input").input_value() or "").strip()
        print(f"typed '7' over '25' -> value: {replaced}")

        # -- cleaning: select-all, then "1a2b" lands as 12 --------------------
        page.keyboard.press("Control+A")
        page.keyboard.type("1a2b", delay=80)
        page.wait_for_timeout(200)
        cleaned = (page.locator("#t-batch-input").input_value() or "").strip()
        cleaned_note = (page.locator(".staff-batch-note").text_content() or "").strip()
        print(f"typed '1a2b' -> value: {cleaned} | note: {cleaned_note}")

        # -- ENTER on the keypad starts the weighing --------------------------
        page.keyboard.press("Enter")
        page.wait_for_selector(".terminal", timeout=5000)
        formula_shown = (page.locator(".current-formula").text_content() or "").strip()
        page.screenshot(path="D:/REMAN Projects/kb_batches_typed.png")
        print(f"ENTER started the weighing, formula: {formula_shown}")
        print("JS errors:", errors or "none")

        ok = (
            typed == "25"
            and note.startswith("The formula is weighed 25 times")
            and up == "26"
            and down == "25"
            and replaced == "7"
            and cleaned == "12"
            and cleaned_note.startswith("The formula is weighed 12 times")
            and formula_shown == "Layer 2"
        )
        print("BATCH COUNT TEST:", "PASSED" if ok else "FAILED")
        b.close()
finally:
    server.shutdown()
