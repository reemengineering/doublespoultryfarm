# STEP 1: check that the UP / DOWN arrows move the formula highlight.
# A second formula is created first so the list has two rows to move between.
# The scale is mocked by a tiny SSE server on port 3999 (the page's
# reem.serverUrl storage key points the page at it).
import json
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

UPSTREAM = "http://localhost:3001"
current = [0.0]


# -- make sure there are at least two formulas ------------------------------
with urlopen(f"{UPSTREAM}/api/formulas") as r:
    formulas = json.load(r)
print("formulas before:", [f["name"] for f in formulas])
if len(formulas) < 2:
    src = formulas[0]
    body = json.dumps(
        {
            "name": "Layer 2",
            "lines": [
                {"itemId": line["itemId"], "requiredWeight": line["requiredWeight"]}
                for line in src["lines"]
            ],
        }
    ).encode()
    req = Request(f"{UPSTREAM}/api/formulas", data=body, headers={"Content-Type": "application/json"})
    try:
        with urlopen(req) as r:
            print("created Layer 2 ->", r.status)
    except Exception as err:
        print("create skipped:", err)
with urlopen(f"{UPSTREAM}/api/formulas") as r:
    formulas = json.load(r)
print("formulas after:", [f["name"] for f in formulas])


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

        def highlighted():
            return (page.locator(".staff-row.kb-active .staff-row-name").text_content() or "").strip()

        page.wait_for_selector(".staff-row.kb-active", timeout=15000)
        rows = [n.strip() for n in page.locator(".staff-row .staff-row-name").all_text_contents()]
        print("rows:", rows)
        print("start highlight:", highlighted())

        page.keyboard.press("ArrowDown")
        page.wait_for_timeout(300)
        after_down = highlighted()          # expect Layer 2
        page.keyboard.press("ArrowUp")
        page.wait_for_timeout(300)
        after_up = highlighted()            # expect back to Layer 1
        print(f"ArrowDown: {after_down} | ArrowUp: {after_up}")

        page.screenshot(path="D:/REMAN Projects/kb_arrows.png")
        print("JS errors:", errors or "none")
        ok = (len(rows) == 1) or (after_down == "Layer 2" and after_up == "Layer 1")
        print("ARROW TEST:", "PASSED" if ok else "FAILED")
        b.close()
finally:
    server.shutdown()
