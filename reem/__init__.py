"""DOUBLES POULTRY FARM weighing terminal.

A Flask port of the weighing terminal: item master, formulas and the weighing
workflow. One process serves both the API and
the UI on http://localhost:3001.

The whole project is deliberately small: this module is the application factory
and the REST API, :mod:`reem.domain` holds the settings and the weighing rules,
and :mod:`reem.store` owns the database.
"""

from __future__ import annotations

from .domain import (
    CONFIG, ROOT, HttpError, error_message, http_error,
    round_off_weight, round_target_weight, slugify,
    TTS_DIR, ensure_tts_dirs,
    ITEM_IMAGES_DIR, ensure_item_images_dir,
    decode_image_data_url, save_item_image, delete_item_image,
    resolve_names, regenerate_names, download_item_audio, delete_item_audio,
    SUPPORTED_BAUD_RATES, ScaleService, create_scale_service,
    create_scale_stream_handler,
)
from .store import init_db, query_one, query_all, run, transaction

# ===========================================================================
# REST API  (was api.py)
# ===========================================================================

import math
import re
import subprocess
import sys
from datetime import datetime

import requests

from flask import Blueprint, Response, jsonify, request


api = Blueprint("api", __name__, url_prefix="/api")

# ---------------------------------------------------------------------------
# Shared constants and validation
# ---------------------------------------------------------------------------

MIN_WEIGHT_KG = 0
MAX_WEIGHT_KG = 1000
# The YH-T7E frame carries six digits, so 9999.9 kg is representable. A target
# above a tonne is a typo, but a measured weight above it is a real sack.
MAX_ACTUAL_WEIGHT_KG = 10000

MAX_NAME_LENGTH = 60
MAX_NATIVE_LENGTH = 60
MAX_FORMULA_LINES = 80


NATIVE_FIELD_LABELS = {
    "name_hi": "Hindi name",
}


def json_body() -> dict:
    """Parse the request body as JSON, answering 400 on malformed input."""
    if not request.data:
        return {}
    try:
        data = request.get_json(force=True, silent=False)
    except Exception:  # noqa: BLE001 - any parse failure is a 400
        raise http_error(400, "Invalid JSON body")
    return data if isinstance(data, dict) else {}


def clean_name(value, label: str) -> str:
    name = str(value or "").strip()
    if not name:
        raise http_error(400, f"{label} is required")
    if len(name) > MAX_NAME_LENGTH:
        raise http_error(400, f"{label} must be {MAX_NAME_LENGTH} characters or fewer")
    return name


def _to_number(value):
    try:
        if value is None or (isinstance(value, str) and value.strip() == ""):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_optional_weight(value) -> float | None:
    """A target weight within the shop's plausible bounds, or None."""
    n = _to_number(value)
    if n is None or not math.isfinite(n):
        return None
    if n < MIN_WEIGHT_KG or n > MAX_WEIGHT_KG:
        return None
    return n


def parse_actual_weight(value) -> float | None:
    """A measured weight within the scale's own ceiling, or None."""
    n = _to_number(value)
    if n is None or not math.isfinite(n):
        return None
    if n < MIN_WEIGHT_KG or n > MAX_ACTUAL_WEIGHT_KG:
        return None
    return n


# ---------------------------------------------------------------------------
# CORS (browser-side control only)
# ---------------------------------------------------------------------------

CORS_ALWAYS_ALLOWED = {
    "http://localhost",
    "https://localhost",
    "http://127.0.0.1",
    "https://127.0.0.1",
    "http://192.168.1.33",
    "capacitor://localhost",
}

_CORS_LOOPBACK = re.compile(
    r"^([a-z][a-z0-9+.-]*)://(\[[0-9a-f:.]+\]|localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$",
    re.IGNORECASE,
)


def _is_allowed_origin(origin: str) -> bool:
    allowed = CORS_ALWAYS_ALLOWED | set(CONFIG.cors_origins)
    if origin in allowed:
        return True
    match = _CORS_LOOPBACK.match(origin)
    if not match:
        return False
    return f"{match.group(1).lower()}://{match.group(2).lower()}" in CORS_ALWAYS_ALLOWED


@api.before_request
def _cors():
    origin = request.headers.get("Origin")
    if not origin:
        return None
    if not _is_allowed_origin(origin):
        return jsonify({"error": "Origin not allowed"}), 403
    if request.method == "OPTIONS":
        response = Response(status=204)
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,DELETE,OPTIONS"
        return response
    # Stash the origin for after_request to echo back.
    request.environ["reem_cors_origin"] = origin
    return None


@api.after_request
def _cors_headers(response):
    origin = request.environ.get("reem_cors_origin")
    if origin:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
    return response


# ---------------------------------------------------------------------------
# Health and shutdown
# ---------------------------------------------------------------------------

@api.get("/health")
def health():
    try:
        query_one("SELECT 1 AS ok")
        return jsonify({"ok": True, "db": "connected"})
    except Exception as err:  # noqa: BLE001
        print(err)
        return jsonify({"ok": False, "db": "error"}), 500


@api.post("/shutdown")
def shutdown():
    body = json_body() or {}
    if body.get("confirm") is not True:
        return (
            jsonify({"error": "Shutdown requires the terminal to confirm it first"}),
            400,
        )
    if body.get("dryRun") is True:
        return jsonify({"ok": True, "dryRun": True})
    try:
        _request_system_shutdown()
        return jsonify({"ok": True})
    except Exception as err:  # noqa: BLE001
        print(f"System shutdown failed: {err}")
        return jsonify({"error": error_message(err, "System shutdown failed")}), 502


def _request_system_shutdown() -> None:
    """Power the machine off the way the kiosk ESC exit would."""
    if sys.platform.startswith("win"):
        command = [
            "shutdown",
            "/s",
            "/t",
            "5",
            "/c",
            "DOUBLES POULTRY FARM terminal is shutting down.",
        ]
    else:
        command = ["systemctl", "poweroff"]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"{' '.join(command)} exited with code {result.returncode}"
        )


# ---------------------------------------------------------------------------
# Scale
# ---------------------------------------------------------------------------

def _scale() -> ScaleService:
    from flask import current_app

    return current_app.extensions["scale"]


@api.get("/scale/ports")
def scale_ports():
    service = _scale()
    return jsonify(
        {
            "enabled": CONFIG.scale_enabled,
            "port": service.get_status()["port"],
            "ports": service.list_ports(),
            "baudRates": SUPPORTED_BAUD_RATES,
            "current": service.get_status(),
        }
    )


@api.get("/scale/status")
def scale_status():
    service = _scale()
    payload = service.public_status()
    payload["reading"] = service.get_reading()
    return jsonify(payload)


@api.get("/scale/stream")
def scale_stream():
    service = _scale()
    return create_scale_stream_handler(service)()


@api.post("/scale/connect")
def scale_connect():
    if not CONFIG.scale_enabled:
        raise http_error(503, "Scale support is disabled (SCALE_ENABLED=0)")
    body = json_body() or {}
    port = body.get("port")
    baud_rate = body.get("baudRate")
    if baud_rate is not None and int(baud_rate) not in SUPPORTED_BAUD_RATES:
        raise http_error(
            400,
            "Unsupported baud rate. Use one of: "
            + ", ".join(str(rate) for rate in SUPPORTED_BAUD_RATES),
        )
    if port is not None and str(port).strip() == "":
        raise http_error(400, "Serial port is required")
    service = _scale()
    status = service.configure(port_path=port, baud_rate=baud_rate)
    if not service.is_running:
        service.start()
    return jsonify(status)


@api.post("/scale/disconnect")
def scale_disconnect():
    service = _scale()
    service.stop()
    return jsonify(service.get_status())


# ---------------------------------------------------------------------------
# Items
# ---------------------------------------------------------------------------

def _to_item_json(row) -> dict:
    return {
        "id": row["id"],
        "slug": row["slug"],
        "code": row["code"],
        "name": row["name"],
        "names": {
            "en": row["name"],
            "hi": row["name_hi"],
        },
        "imagePath": row["image_path"] or None,
        "createdAt": row["created_at"],
    }


@api.get("/items")
def list_items():
    rows = query_all("SELECT * FROM items ORDER BY code ASC, name ASC")
    return jsonify([_to_item_json(row) for row in rows])


@api.post("/items")
def create_item():
    body = json_body() or {}
    name = clean_name(body.get("name"), "Item name")

    for field, label in NATIVE_FIELD_LABELS.items():
        value = str(body.get(field) or "").strip()
        if len(value) > MAX_NATIVE_LENGTH:
            return (
                jsonify({"error": f"{label} must be {MAX_NATIVE_LENGTH} characters or fewer"}),
                400,
            )

    existing = query_one("SELECT COUNT(*) AS n FROM items WHERE name = ?", (name,))
    if int(existing["n"]) > 0:
        return jsonify({"error": f'Item "{name}" already exists'}), 409

    code_row = query_one(
        "SELECT code FROM items WHERE code LIKE 'RM-%' ORDER BY code DESC LIMIT 1"
    )
    next_num = int(code_row["code"][3:]) + 1 if code_row else 1
    code = f"RM-{next_num:02d}"

    slug = slugify(name)
    slug_exists = query_one("SELECT COUNT(*) AS n FROM items WHERE slug = ?", (slug,))
    if int(slug_exists["n"]) > 0:
        slug = f"{slug}-{next_num}"

    try:
        names = resolve_names(
            name,
            {
                "hi": body.get("name_hi"),
            },
        )
    except Exception as err:  # noqa: BLE001
        print(f"name resolution failed, using English: {error_message(err, 'unknown error')}")
        names = {"hi": name}

    cursor = run(
        "INSERT INTO items (slug, code, name, name_hi) "
        "VALUES (?, ?, ?, ?)",
        (slug, code, name, names["hi"]),
    )
    row = query_one("SELECT * FROM items WHERE id = ?", (cursor.lastrowid,))

    try:
        download_item_audio(slug, {"en": name, **names})
    except Exception as err:  # noqa: BLE001
        print(f"item audio download failed: {error_message(err, 'unknown error')}")

    return jsonify(_to_item_json(row)), 201


@api.put("/items/<int:item_id>")
def update_item(item_id: int):
    row = query_one("SELECT * FROM items WHERE id = ?", (item_id,))
    if not row:
        return jsonify({"error": "Item not found"}), 404

    body = json_body() or {}
    name = clean_name(body.get("name"), "Item name")

    for field, label in NATIVE_FIELD_LABELS.items():
        value = str(body.get(field) or "").strip()
        if len(value) > MAX_NATIVE_LENGTH:
            return (
                jsonify({"error": f"{label} must be {MAX_NATIVE_LENGTH} characters or fewer"}),
                400,
            )

    clash = query_one(
        "SELECT COUNT(*) AS n FROM items WHERE name = ? AND id <> ?", (name, item_id)
    )
    if int(clash["n"]) > 0:
        return jsonify({"error": f'Item "{name}" already exists'}), 409

    try:
        names = resolve_names(
            name,
            {
                "hi": body.get("name_hi"),
            },
        )
    except Exception as err:  # noqa: BLE001
        print(f"name resolution failed, using English: {error_message(err, 'unknown error')}")
        names = {"hi": name}

    # The slug, code and photo stay put so existing audio clips and pictures keep
    # working; only the display names change. Fresh clips use the new text.
    run(
        "UPDATE items SET name = ?, name_hi = ? WHERE id = ?",
        (name, names["hi"], item_id),
    )
    download_item_audio(row["slug"], {"en": name, **names})

    updated = query_one("SELECT * FROM items WHERE id = ?", (item_id,))
    return jsonify(_to_item_json(updated))


@api.post("/items/<int:item_id>/regenerate")
def regenerate_item(item_id: int):
    row = query_one("SELECT * FROM items WHERE id = ?", (item_id,))
    if not row:
        return jsonify({"error": "Item not found"}), 404

    names = regenerate_names(
        row["name"],
        {"hi": row["name_hi"]},
    )
    run(
        "UPDATE items SET name_hi = ? WHERE id = ?",
        (names["hi"], item_id),
    )
    download_item_audio(row["slug"], {"en": row["name"], **names})

    updated = query_one("SELECT * FROM items WHERE id = ?", (item_id,))
    return jsonify(_to_item_json(updated))


@api.post("/items/<int:item_id>/image")
def set_item_image(item_id: int):
    row = query_one("SELECT * FROM items WHERE id = ?", (item_id,))
    if not row:
        return jsonify({"error": "Item not found"}), 404

    try:
        data, ext = decode_image_data_url((json_body() or {}).get("dataUrl"))
    except HttpError as err:
        return jsonify({"error": err.message}), err.status

    image_path = save_item_image(row["slug"], data, ext)
    try:
        run(
            "UPDATE items SET image_path = ? WHERE id = ?", (image_path, item_id)
        )
    except Exception as err:  # noqa: BLE001
        # Nothing will point at the file just written, so it must not leak.
        delete_item_image(image_path)
        raise err

    if row["image_path"]:
        delete_item_image(row["image_path"])

    updated = query_one("SELECT * FROM items WHERE id = ?", (item_id,))
    return jsonify(_to_item_json(updated))


@api.post("/items/<int:item_id>/fetch-image")
def fetch_item_image(item_id: int):
    row = query_one("SELECT * FROM items WHERE id = ?", (item_id,))
    if not row:
        return jsonify({"error": "Item not found"}), 404

    body = request.get_json(silent=True) or {}
    name = (body.get("name") or row["name"] or "").strip()
    if not name:
        return jsonify({"error": "Name required"}), 400

    slug_seed = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or f"item-{item_id}"
    query = requests.utils.quote(name)

    urls = [
        f"https://picsum.photos/seed/{slug_seed}/512/512",
        f"https://picsum.photos/512/512?random={datetime.now().timestamp()}",
        f"https://loremflickr.com/512/512/{query}",
        f"https://source.unsplash.com/512x512/?{query}",
    ]

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    }

    for url in urls:
        try:
            resp = requests.get(url, headers=headers, timeout=15, allow_redirects=True)
            if resp.status_code == 200 and resp.content:
                ctype = resp.headers.get("Content-Type", "").lower()
                if "png" in ctype:
                    ext = "png"
                elif "webp" in ctype:
                    ext = "webp"
                else:
                    ext = "jpg"
                stored = save_item_image(row["slug"], resp.content, ext)
                run("UPDATE items SET image_path = ? WHERE id = ?", (stored, item_id))
                updated = query_one("SELECT * FROM items WHERE id = ?", (item_id,))
                return jsonify(_to_item_json(updated))
        except Exception:
            continue

    return jsonify({"error": "Failed to fetch image from internet"}), 502


@api.delete("/items/<int:item_id>/image")
def clear_item_image(item_id: int):
    row = query_one("SELECT * FROM items WHERE id = ?", (item_id,))
    if not row:
        return jsonify({"error": "Item not found"}), 404
    run("UPDATE items SET image_path = NULL WHERE id = ?", (item_id,))
    delete_item_image(row["image_path"])
    updated = query_one("SELECT * FROM items WHERE id = ?", (item_id,))
    return jsonify(_to_item_json(updated))


@api.delete("/items/<int:item_id>")
def delete_item(item_id: int):
    row = query_one(
        "SELECT slug, image_path FROM items WHERE id = ?", (item_id,)
    )
    if not row:
        return jsonify({"error": "Item not found"}), 404

    used_by = query_all(
        "SELECT f.name AS name FROM formula_lines fl "
        "JOIN formulas f ON f.id = fl.formula_id "
        "WHERE fl.item_id = ? ORDER BY f.name",
        (item_id,),
    )
    if used_by:
        names = [entry["name"] for entry in used_by]
        preview = names[:3]
        suffix = ", …" if len(names) > 3 else ""
        plural = "" if len(names) == 1 else "s"
        return (
            jsonify(
                {
                    "error": (
                        f"This item is used by {len(names)} formula{plural} "
                        f"({', '.join(preview)}{suffix}). Delete or update those formulas first."
                    ),
                    "formulas": names,
                }
            ),
            409,
        )

    run("DELETE FROM items WHERE id = ?", (item_id,))
    delete_item_audio(row["slug"])
    delete_item_image(row["image_path"])
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Formulas
# ---------------------------------------------------------------------------

def _to_formula_json(row, lines: list) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "itemCount": row["item_count"],
        "totalWeight": row["total_weight"],
        "createdAt": row["created_at"],
        "lines": lines,
    }


def _line_json(row) -> dict:
    return {
        "id": row["id"],
        "formulaId": row["formulaId"],
        "itemId": row["itemId"],
        "itemName": row["itemName"],
        "requiredWeight": row["requiredWeight"],
        "position": row["position"],
    }


FORMULA_LINES_SQL = (
    "SELECT id, formula_id AS formulaId, item_id AS itemId, "
    "item_name AS itemName, required_weight AS requiredWeight, position "
    "FROM formula_lines WHERE formula_id = ? ORDER BY position ASC"
)
FORMULA_LINES_INSERT_SQL = (
    "INSERT INTO formula_lines (formula_id, item_id, item_name, required_weight, position) "
    "VALUES (?, ?, ?, ?, ?)"
)


def _parse_formula_body(body: dict) -> dict:
    name = clean_name(body.get("name"), "Formula name")

    raw_lines = body.get("lines")
    raw_lines = raw_lines if isinstance(raw_lines, list) else []
    lines: list[dict] = []
    seen: set[int] = set()
    for raw in raw_lines:
        if len(lines) >= MAX_FORMULA_LINES:
            break
        if not isinstance(raw, dict):
            continue
        try:
            item_id = int(raw.get("itemId"))
        except (TypeError, ValueError):
            continue
        required_weight = parse_optional_weight(raw.get("requiredWeight"))
        if item_id <= 0:
            continue
        if required_weight is None or required_weight <= 0:
            continue
        if item_id in seen:
            continue
        seen.add(item_id)
        item = query_one("SELECT id, name FROM items WHERE id = ?", (item_id,))
        if not item:
            continue
        lines.append(
            {
                "itemId": item_id,
                "itemName": item["name"],
                "requiredWeight": round_target_weight(required_weight),
            }
        )
    if not lines:
        raise http_error(
            400, "Formula needs at least one valid ingredient with a weight above zero"
        )
    return {"name": name, "lines": lines}


@api.get("/formulas")
def list_formulas():
    rows = query_all("SELECT * FROM formulas ORDER BY name ASC")
    line_rows = query_all(
        "SELECT id, formula_id AS formulaId, item_id AS itemId, "
        "item_name AS itemName, required_weight AS requiredWeight, position "
        "FROM formula_lines ORDER BY formula_id ASC, position ASC"
    )
    by_formula: dict[int, list] = {}
    for line in line_rows:
        by_formula.setdefault(int(line["formulaId"]), []).append(_line_json(line))
    return jsonify([_to_formula_json(row, by_formula.get(int(row["id"]), [])) for row in rows])


@api.post("/formulas")
def create_formula():
    try:
        parsed = _parse_formula_body(json_body() or {})
    except HttpError as err:
        return jsonify({"error": err.message}), err.status

    existing = query_one(
        "SELECT COUNT(*) AS n FROM formulas WHERE name = ?", (parsed["name"],)
    )
    if int(existing["n"]) > 0:
        return jsonify({"error": f'Formula "{parsed["name"]}" already exists'}), 409

    item_count = len(parsed["lines"])
    total_weight = round(sum(line["requiredWeight"] for line in parsed["lines"]), 3)

    try:
        with transaction() as conn:
            cursor = conn.execute(
                "INSERT INTO formulas (name, item_count, total_weight) VALUES (?, ?, ?)",
                (parsed["name"], item_count, total_weight),
            )
            formula_id = cursor.lastrowid
            for index, line in enumerate(parsed["lines"]):
                conn.execute(
                    FORMULA_LINES_INSERT_SQL,
                    (formula_id, line["itemId"], line["itemName"], line["requiredWeight"], index),
                )
    except Exception as err:  # noqa: BLE001
        print(err)
        return jsonify({"error": "Failed to save formula"}), 500

    row = query_one("SELECT * FROM formulas WHERE id = ?", (formula_id,))
    lines = [
        {
            "id": index,
            "formulaId": formula_id,
            "itemId": line["itemId"],
            "itemName": line["itemName"],
            "requiredWeight": line["requiredWeight"],
            "position": index,
        }
        for index, line in enumerate(parsed["lines"])
    ]
    return jsonify(_to_formula_json(row, lines)), 201


@api.put("/formulas/<int:formula_id>")
def update_formula(formula_id: int):
    if not query_one("SELECT id FROM formulas WHERE id = ?", (formula_id,)):
        return jsonify({"error": "Formula not found"}), 404

    try:
        parsed = _parse_formula_body(json_body() or {})
    except HttpError as err:
        return jsonify({"error": err.message}), err.status

    name_dup = query_one(
        "SELECT COUNT(*) AS n FROM formulas WHERE name = ? AND id != ?",
        (parsed["name"], formula_id),
    )
    if int(name_dup["n"]) > 0:
        return jsonify({"error": f'Formula "{parsed["name"]}" already exists'}), 409

    item_count = len(parsed["lines"])
    total_weight = round(sum(line["requiredWeight"] for line in parsed["lines"]), 3)

    try:
        with transaction() as conn:
            conn.execute(
                "UPDATE formulas SET name = ?, item_count = ?, total_weight = ? WHERE id = ?",
                (parsed["name"], item_count, total_weight, formula_id),
            )
            conn.execute("DELETE FROM formula_lines WHERE formula_id = ?", (formula_id,))
            for index, line in enumerate(parsed["lines"]):
                conn.execute(
                    FORMULA_LINES_INSERT_SQL,
                    (formula_id, line["itemId"], line["itemName"], line["requiredWeight"], index),
                )
    except Exception as err:  # noqa: BLE001
        print(err)
        return jsonify({"error": "Failed to update formula"}), 500

    row = query_one("SELECT * FROM formulas WHERE id = ?", (formula_id,))
    lines = [_line_json(line) for line in query_all(FORMULA_LINES_SQL, (formula_id,))]
    return jsonify(_to_formula_json(row, lines))


@api.delete("/formulas/<int:formula_id>")
def delete_formula(formula_id: int):
    cursor = run("DELETE FROM formulas WHERE id = ?", (formula_id,))
    if cursor.rowcount == 0:
        return jsonify({"error": "Formula not found"}), 404
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Error handling inside the blueprint
# ---------------------------------------------------------------------------

@api.errorhandler(HttpError)
def _handle_http_error(err: HttpError):
    return jsonify({"error": err.message}), err.status

# ===========================================================================
# Application factory  (was __init__.py)
# ===========================================================================

import os

from flask import Flask, jsonify, send_from_directory
from werkzeug.exceptions import HTTPException


__version__ = "1.0.0"


def create_app(test_config: dict | None = None) -> Flask:
    # The templates and static assets live at the project root, beside the
    # package, so the code and the shop's data stay in separate top-level trees.
    app = Flask(
        __name__,
        template_folder=str(ROOT / "templates"),
        static_folder=str(ROOT / "static"),
        static_url_path="/static",
    )
    app.config.from_mapping(
        SECRET_KEY=os.environ.get("SECRET_KEY", "reem-weighing-terminal"),
        JSON_SORT_KEYS=False,
        # Item photos arrive as data: URLs, far larger than any other body.
        # 9 MB leaves room for an 8 MB image plus its JSON wrapper.
        MAX_CONTENT_LENGTH=9 * 1024 * 1024,
    )
    if test_config:
        app.config.update(test_config)

    # ------------------------------------------------------------------
    # Database and on-disk storage
    # ------------------------------------------------------------------
    init_db(CONFIG.db_path)
    ensure_tts_dirs()
    ensure_item_images_dir()

    # ------------------------------------------------------------------
    # Scale service (optional hardware)
    # ------------------------------------------------------------------
    scale_service: ScaleService = create_scale_service(
        enabled=CONFIG.scale_enabled
    )
    app.extensions["scale"] = scale_service
    if CONFIG.scale_enabled:
        scale_service.start()

    # ------------------------------------------------------------------
    # API
    # ------------------------------------------------------------------
    app.register_blueprint(api)

    # ------------------------------------------------------------------
    # Static assets: item photos and voice clips
    # ------------------------------------------------------------------
    @app.get("/item-images/<path:filename>")
    def item_images(filename: str):
        response = send_from_directory(ITEM_IMAGES_DIR, filename)
        response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/tts/<path:filename>")
    def tts_files(filename: str):
        response = send_from_directory(TTS_DIR, filename)
        response.headers["Cache-Control"] = "no-cache"
        return response

    # ------------------------------------------------------------------
    # The single page UI
    # ------------------------------------------------------------------
    @app.get("/")
    def index():
        return serve_page(staff=False)

    @app.get("/staff/")
    @app.get("/staff")
    def staff():
        return serve_page(staff=True)

    @app.errorhandler(404)
    def not_found(_err):
        # Unknown /api paths must answer as JSON: the clients parse every API
        # response as JSON and a stray HTML 404 surfaced as a syntax error.
        from flask import request

        if request.path.startswith("/api"):
            return jsonify({"error": "Unknown API endpoint"}), 404
        return serve_page(staff=False), 404

    @app.errorhandler(HTTPException)
    def http_exception(err: HTTPException):
        # Malformed JSON, an oversized body or a wrong method must reach an API
        # client as JSON, not Werkzeug's HTML page, or the client reports a
        # syntax error instead of the real fault.
        from flask import request

        if request.path.startswith("/api"):
            message = err.description or err.name
            return jsonify({"error": message}), err.code or 500
        return err

    @app.errorhandler(Exception)
    def unhandled(err: Exception):
        print(err)
        from flask import request

        if request.path.startswith("/api"):
            return jsonify({"error": "Server error"}), 500
        return "<h1>Server error</h1>", 500

    @app.errorhandler(HttpError)
    def http_error_handler(err: HttpError):
        from flask import request

        if request.path.startswith("/api"):
            return jsonify({"error": err.message}), err.status
        return err.message, err.status

    @app.after_request
    def hardening_headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
        # The kiosk browsers sit on a trusted LAN and must never run stale
        # JS/CSS: default Flask heuristic caching (a fraction of the file age)
        # can pin an old script for days. no-cache forces an ETag revalidate
        # every load, which is a cheap 304 when nothing changed. Scoped to the
        # static JS/CSS responses only, so API/SSE streams are untouched.
        if response.mimetype in ("text/css", "application/javascript", "text/javascript"):
            response.headers["Cache-Control"] = "no-cache"
        return response

    return app


def serve_page(staff: bool = False):
    """Return a rendered static page from the templates directory."""
    from pathlib import Path

    from flask import render_template

    # The kiosk browsers cache assets heuristically (Flask default: a fraction
    # of the file age, which can mean days), so they kept running old JS until
    # the cache expired. Bump the asset version on every code change; the
    # no-cache revalidation header in the app factory covers the nested module
    # imports (import './lib.js') that this query string cannot reach.
    static_dir = Path(__file__).resolve().parent.parent / "static"
    js_dir = static_dir / "js"
    mtimes = [
        int(path.stat().st_mtime)
        for path in (
            static_dir / "css" / "app.css",
            js_dir / "lib.js",
            js_dir / "app.js",
            js_dir / "staff.js",
        )
        if path.exists()
    ]
    asset_ver = str(max(mtimes)) if mtimes else "0"
    return render_template(
        "index.html",
        brand=CONFIG.brand_name,
        version=__version__,
        staff=staff,
        asset_ver=asset_ver,
    )
