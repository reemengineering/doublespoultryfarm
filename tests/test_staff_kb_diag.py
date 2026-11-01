# Standalone diagnostic: starts the mock SSE server, then dumps the staff
# terminal's stage markers so we can see where the hover/hover state stalls.
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

try:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(viewport={"width": 1080, "height": 1920})
        ctx.add_init_script("localStorage.setItem('reem.serverUrl','http://localhost:3999')")
        page = ctx.new_page()
        page.on("pageerror", lambda e: print("PAGEERROR:", e))
        page.on("console", lambda m: m.type == "error" and print("CONSOLE:", m.text))
        page.goto("http://localhost:3001/staff/", wait_until="networkidle")
        page.wait_for_selector(".staff-row", timeout=20000)
        page.locator("[data-action='select-formula']").first.click()
        page.wait_for_timeout(300)
        page.keyboard.press("Enter")
        page.wait_for_selector(".terminal", timeout=10000)

        def dump(tag):
            info = page.evaluate(
                """() => ({
                    advance: document.querySelector('#t-advance-title')?.textContent ?? null,
                    lcdStatus: document.querySelector('#t-lcd')?.dataset.status ?? null,
                    lcd: document.querySelector('#t-lcd')?.textContent ?? null,
                    lcdStatus: document.querySelector('#t-lcd')?.dataset.status ?? null,
                    target: document.querySelector('.sketch-target-value')?.textContent ?? null,
                    item: document.querySelector('.current-item-name')?.textContent ?? null,
                    advanceHidden: document.getElementById('t-advance')?.hidden ?? null,
                    advanceTitle: document.getElementById('t-advance-title')?.textContent ?? null,
                    zeroLabel: document.querySelector('[data-extra-label]')?.textContent ?? null,
                })"""
            )
            print(tag, info)

        dump("t=0s  ")
        # Simulate item 1 being weighed: 1.0 kg arrives on the pan.
        current[0] = 1.0
        page.wait_for_timeout(1300)
        dump("+1kg  ")
        page.wait_for_timeout(3200)
        page.screenshot(path="D:/REMAN Projects/kb_terminal_new.png")
        print("still on same item?", page.locator(".sketch-target-value").count())
        b.close()
finally:
    server.shutdown()
    print("diag done")

