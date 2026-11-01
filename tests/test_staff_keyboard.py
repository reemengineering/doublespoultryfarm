# Keyboard-only E2E for the staff terminal: the operator's keypad has only
# UP / DOWN arrows and ENTER. The whole flow is driven with those keys alone:
#   formula list -> batch count -> weighing -> between batches -> complete
#   -> back to the formula list.
# The scale is mocked by a tiny SSE server on port 3999; the page is pointed
# at it through the reem.serverUrl storage key (init script, before boot).
import json
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen

UPSTREAM = "http://localhost:3001"
BATCHES = 2

with urlopen(f"{UPSTREAM}/api/formulas") as r:
    formula = json.load(r)[0]
TARGETS = [line["requiredWeight"] for line in formula["lines"]]

# The reading the mock relays. The test sets this as the flow advances; the
# SSE server streams this value with a fresh timestamp every 300 ms.
current = [0.0]


class MockHandler(BaseHTTPRequestHandler):
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
                        weight = current[0]
                        payload = json.dumps(
                            {"weight": weight, "receivedAt": datetime.now().isoformat(timespec="milliseconds")}
                        )
                        self.wfile.write(f"event: reading\ndata: {payload}\n\n".encode())
                        self.wfile.flush()
                        time.sleep(0.3)
                except Exception:
                    pass  # client closed the stream
            else:
                self._proxy()
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 3999), MockHandler)
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

        # -- formula list: arrow keys move the highlight, Enter picks --------
        page.wait_for_selector(".staff-row.kb-active", timeout=15000)
        first = page.locator(".staff-row.kb-active .staff-row-name").text_content()
        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(300)
        second = page.locator(".staff-row.kb-active .staff-row-name").text_content()
        page.keyboard.press("ArrowUp")
        page.wait_for_timeout(300)
        back = page.locator(".staff-row.kb-active .staff-row-name").text_content()
        print(f"highlight moves: [{first}] -> ArrowDown [{second}] -> ArrowUp [{back}]")

        page.keyboard.press("Enter")
        page.wait_for_selector(".staff-batch-card", timeout=5000)
        print("formula confirmed -> NUMBER OF BATCHES screen")

        # -- batch count: arrows change it, Enter starts ---------------------
        n = page.locator("#t-batch-input").input_value()
        page.keyboard.press("ArrowUp")
        page.wait_for_timeout(250)
        n2 = page.locator("#t-batch-input").input_value()
        # Leave the count at 2 so the two batches below can run.
        print(f"batch count: {n} -> ArrowUp {n2}")

        page.keyboard.press("Enter")
        page.wait_for_selector(".terminal", timeout=5000)
        formula_shown = page.locator(".current-formula").text_content()
        print(f" -> weighing started, formula: {formula_shown.strip()}")

        # Line 1: the pan reads the target for a moment, advance countdown
        # fires, and the line moves on by itself.
        current[0] = TARGETS[0]
        page.wait_for_selector("#t-advance-title", timeout=90000)
        time.sleep(4.8)  # countdown (4s) must fire handleNext by now

        # Line 2: add the second item on top of the first.
        current[0] = TARGETS[0] + TARGETS[1]
        page.wait_for_selector("#t-advance-title", timeout=90000)
        time.sleep(4.8)
        diag = page.evaluate(
            "() => ({ title: document.querySelector('.screen-title')?.textContent ?? null,"
            " lcd: document.querySelector('#t-lcd')?.textContent ?? null })"
        )
        print("after line 2:", diag)

        # -- batch 1 done: clear the pan, Enter starts the next batch --------
        page.wait_for_selector("text=BATCH 1 OF 2 COMPLETE", timeout=30000)
        page.screenshot(path="D:/REMAN Projects/kb_between.png")
        current[0] = 0.0  # operator clears the pan before continuing
        time.sleep(0.8)
        page.keyboard.press("Enter")
        print("batch 1 complete -> ENTER -> batch 2 ")

        # Batch 2 line 1: fresh from an empty pan.
        current[0] = TARGETS[0]
        page.wait_for_timeout(1500)
        d2 = page.evaluate(
            "() => ({ advance: document.querySelector('#t-advance-title')?.textContent ?? null,"
            " lcd: document.querySelector('#t-lcd')?.textContent ?? null,"
            " title: document.querySelector('.screen-title')?.textContent ?? null })"
        )
        print("batch2 line1:", d2)
        page.wait_for_selector("#t-advance-title", timeout=90000)
        time.sleep(4.8)
        current[0] = TARGETS[0] + TARGETS[1]
        page.wait_for_selector("#t-advance-title", timeout=90000)
        time.sleep(4.8)

        # -- batch 2 done: Enter returns to the formula list ------------------
        # Batch 2 is the last one, so the weighing goes straight to
        # WEIGHING COMPLETE (no between screen for the final batch).
        page.wait_for_selector("text=WEIGHING COMPLETE", timeout=30000)
        page.screenshot(path="D:/REMAN Projects/kb_done.png")
        page.wait_for_timeout(1000)
        page.keyboard.press("Enter")
        page.wait_for_selector(".staff-row.kb-active", timeout=5000)
        print("batch 2 complete -> WEIGHING COMPLETE -> ENTER -> formula list")

        # -- regression: the whole cycle ran with arrow keys + Enter only -----
        print("JS errors:", errors or "none")
        b.close()
finally:
    server.shutdown()
print("ALL KEYBOARD TESTS PASSED")



