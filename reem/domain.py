"""Settings, the weighing rules and the machine-facing services.

This is the leaf module of the package: the process configuration and the
project paths, the HTTP error type, the shop's rounding and verdict rules, the
tare zero point, name translation and voice clips, item photo storage and the
optional YH-T7E serial scale. It imports nothing else inside ``reem`` so the
store and the HTTP layer can both build on it.
"""

from __future__ import annotations


# ===========================================================================
# Configuration and paths  (was config.py)
# ===========================================================================

import os
from dataclasses import dataclass
from pathlib import Path

# Project root: the directory that contains the ``reem`` package.
ROOT = Path(__file__).resolve().parent.parent

# Runtime data that must survive a restart. Kept out of the package so the code
# can be replaced wholesale without touching the shop's records.
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data"))
STORAGE_DIR = DATA_DIR / "storage"


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Config:
    """Immutable view of the process configuration."""

    brand_name: str
    footer_text: str

    host: str
    port: int

    data_dir: Path
    db_path: Path
    scale_config_file: Path

    scale_enabled: bool

    cors_origins: tuple[str, ...]

    @property
    def storage_dir(self) -> Path:
        return STORAGE_DIR


CONFIG = Config(
    brand_name="DOUBLES POULTRY FARM",
    footer_text="© Copyright Reem Engineering Enterprises",
    host=os.environ.get("HOST", "0.0.0.0"),
    port=_int_env("PORT", 3001),
    data_dir=DATA_DIR,
    db_path=Path(os.environ.get("DB_PATH", DATA_DIR / "reem.db")),
    scale_config_file=DATA_DIR / "scale-config.json",
    # A machine with no scale wired up still serves the item master and reports;
    # weighing itself then reports the scale offline rather than inventing weight.
    scale_enabled=os.environ.get("SCALE_ENABLED", "1") != "0",
    cors_origins=tuple(
        origin.strip()
        for origin in os.environ.get("CORS_ORIGIN", "").split(",")
        if origin.strip()
    ),
)

# Make sure the data directories exist before anything tries to write to them.
DATA_DIR.mkdir(parents=True, exist_ok=True)
STORAGE_DIR.mkdir(parents=True, exist_ok=True)

# ===========================================================================
# HTTP errors  (was errors.py)
# ===========================================================================

class HttpError(Exception):
    """An error a handler can raise to answer with a specific HTTP status."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def http_error(status: int, message: str) -> HttpError:
    return HttpError(status, message)


def error_status(err: Exception, fallback: int) -> int:
    if isinstance(err, HttpError):
        return err.status
    return fallback


def error_message(err: Exception, fallback: str) -> str:
    return str(err) if str(err) else fallback

# ===========================================================================
# Weight rounding and verdicts  (was weights.py)
# ===========================================================================

import math

# No target below this: a rounded weight of zero is not a weighing.
MIN_TARGET_KG = 1


def js_round(value: float) -> int:
    """Replicate JavaScript's ``Math.round`` (half rounds toward +Infinity).

    Python's built-in ``round`` uses banker's rounding, which would send 0.5 to
    0 instead of 1 and quietly drift the whole rounding rule.
    """
    return math.floor(value + 0.5)


def round3(value: float) -> float:
    """Three-decimal rounding, matching ``Math.round(v * 1000) / 1000``."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(number):
        return 0.0
    return js_round(number * 1000) / 1000


def round_off_weight(kg: float) -> int:
    """Round a weight DOWN to the whole kilogram below it.

    50.8 kg becomes 50, 51.4 kg becomes 51. A measured weight is rounded the
    same way a target is, so 51.2 kg on the scale reads as 51 kg and matches a
    51 kg target. A measured weight is never lifted to 1 kg.
    """
    try:
        number = float(kg)
    except (TypeError, ValueError):
        return 0
    if not math.isfinite(number):
        return 0
    # Snapped to 0.001 kg before dropping the remainder, so a value a hair under
    # a kilogram because of floating-point noise is not treated as a whole kilo
    # less. A scale reporting 50.9999999999 means 51.000 and must land on 51.
    scaled = js_round(number * 1000)
    if not math.isfinite(scaled):
        return 0
    # Floor toward zero on the way down: a scale can sit below zero with an
    # empty pan, and flooring -0.5 to -1 would grow the gap on every line.
    whole = scaled / 1000
    result = math.ceil(whole) if whole < 0 else math.floor(whole)
    return int(result) + 0


def round_target_weight(kg: float) -> int:
    """Snap a typed target down to the whole kilogram below it.

    A target that would round down to zero is lifted to 1 kg instead: a 0 kg
    target cannot be weighed or saved, so the smallest usable target is the
    floor.
    """
    try:
        number = float(kg)
    except (TypeError, ValueError):
        return MIN_TARGET_KG
    if not math.isfinite(number):
        return MIN_TARGET_KG
    return max(MIN_TARGET_KG, round_off_weight(number))


def _format_target(kg: float) -> str:
    return str(int(kg)) if float(kg).is_integer() else f"{kg:.1f}"


def target_rounding_note(kg: float) -> str | None:
    """What the operator typed against what will be used, or None if equal."""
    try:
        number = float(kg)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number <= 0:
        return None
    rounded = round_target_weight(number)
    if rounded == number:
        return None
    return f"{_format_target(number)} will be weighed as {_format_target(rounded)} kg"


# ---------------------------------------------------------------------------
# Reading evaluation (shared by the client)
# ---------------------------------------------------------------------------

def fmt_weight(weight: float) -> str:
    return f"{weight:.3f} kg"


def fmt_weight_no_unit(weight: float) -> str:
    return f"{weight:.3f}"


def fmt_signed_diff(diff: float) -> str:
    sign = "+" if diff > 0 else ""
    return f"{sign}{diff:.3f} kg"


def evaluate_reading(required: float, current: float | None) -> dict:
    """Compare a reading against the required weight and describe the gap.

    ``current is None`` means nothing has been weighed yet. The reading is
    rounded down to whole kilograms the same way the target is, so a 51 kg
    target is met by any reading from 51.000 up to 51.999.
    """
    if current is None:
        return {
            "type": "neutral",
            "title": "AWAITING INPUT",
            "detail": "Enter the current weight",
            "difference": None,
            "correct": False,
        }
    difference = round3(round_off_weight(current) - required)
    if difference == 0:
        return {
            "type": "accepted",
            "title": "WEIGHT ACCEPTED",
            "detail": "ON TARGET",
            "difference": difference,
            "correct": True,
        }
    if difference < 0:
        return {
            "type": "underweight",
            "title": "UNDERWEIGHT",
            "detail": f"Add {fmt_weight(round3(-difference))}",
            "difference": difference,
            "correct": False,
        }
    return {
        "type": "overweight",
        "title": "OVERWEIGHT",
        "detail": f"Remove {fmt_weight(difference)}",
        "difference": difference,
        "correct": False,
    }

# ===========================================================================
# Tare zero point  (was tare_baseline.py)
# ===========================================================================

import math


def _round3(value: float) -> float:
    return math.floor(value * 1000 + 0.5) / 1000


class TareBaseline:
    """Accumulated reading treated as zero for the line being weighed."""

    def __init__(self, drop_tolerance: float = 0.5) -> None:
        self._base = 0.0
        # False while the scale has not yet said what an empty pan reads.
        self._established = False
        self._drop_tolerance = drop_tolerance

    def zero_at(self, current: float | None) -> None:
        """Treat whatever the scale is reading right now as zero."""
        if current is None:
            self._established = False
            return
        self._base = _round3(current)
        self._established = True

    def adopt_empty_pan(self, current: float | None) -> bool:
        """Take the zero point from a reading that says the pan is empty.

        Only a reading at or below zero is taken, because that is the only
        reading that proves the pan is empty: had the operator already poured,
        the reading would be positive.
        """
        if self._established or current is None or current > 0:
            return False
        self.zero_at(current)
        return True

    def is_established(self) -> bool:
        return self._established

    def net(self, current: float | None) -> float | None:
        """Weight sitting on top of the zero point; never negative."""
        if current is None:
            return None
        return max(0.0, _round3(_round3(current) - self._base))

    def under_base(self, current: float | None) -> bool:
        """True when the reading dropped well below the zero point."""
        if current is None or not self._established:
            return False
        return _round3(current) - self._base < -self._drop_tolerance

    def carry(self, accumulated: float | None) -> None:
        """The accumulated reading a line was accepted at becomes the next zero."""
        if accumulated is None:
            return
        self._base = _round3(accumulated)
        self._established = True

    def reset(self) -> None:
        self._base = 0.0
        self._established = False

    def base_value(self) -> float:
        return self._base

# ===========================================================================
# Name translation and voice clips  (was tts.py)
# ===========================================================================

import json
import re
import time
import urllib.parse
import urllib.request


TTS_DIR = STORAGE_DIR / "tts"

LANGUAGES = ("en", "hi")
TRANSLATE_LANGS = ("hi",)

UA = {"User-Agent": "Mozilla/5.0"}
REMOTE_TIMEOUT_S = 10
REMOTE_ATTEMPTS = 3
RETRY_BASE_S = 0.7

# The `client=gtx` query string is the one Google rate-limits first. The
# browser-extension client answers out of a different bucket, so both are tried.
TRANSLATE_CLIENTS = ("dict-chrome-ex", "gtx")


def ensure_tts_dirs() -> None:
    for lang in LANGUAGES:
        (TTS_DIR / lang).mkdir(parents=True, exist_ok=True)


def _remote_disabled() -> bool:
    """True when the shop asked for no outbound calls (offline install)."""
    import os

    return os.environ.get("REEM_DISABLE_REMOTE", "0") == "1"


def slugify(text: str) -> str:
    slug = re.sub(r"\s+", "-", str(text).lower().strip())
    slug = re.sub(r"[^a-z0-9-]", "", slug)
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug or "item"


def _http_get(url: str) -> tuple[int, bytes, str]:
    request = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(request, timeout=REMOTE_TIMEOUT_S) as response:
        body = response.read()
        return response.status, body, response.headers.get("Content-Type", "")


def _translate_with_client(text: str, target: str, client: str) -> str:
    url = (
        "https://translate.googleapis.com/translate_a/single"
        f"?client={client}&sl=en&tl={target}&dt=t&q={urllib.parse.quote(text)}"
    )
    status, body, _ = _http_get(url)
    if status != 200:
        raise RuntimeError(f"translate http {status}")
    data = json.loads(body.decode("utf-8", "replace"))
    segments = data[0] if isinstance(data, list) and data else None
    translated = ""
    if isinstance(segments, list):
        parts = []
        for segment in segments:
            if isinstance(segment, list) and segment:
                parts.append(str(segment[0] or ""))
        translated = "".join(parts).strip()
    return translated or text


def _translate_once(text: str, target: str) -> str:
    last_error: Exception | None = None
    for client in TRANSLATE_CLIENTS:
        try:
            return _translate_with_client(text, target, client)
        except Exception as err:  # noqa: BLE001 - fall through to the next client
            last_error = err
    raise last_error if last_error else RuntimeError("translate failed")


def _translate_text(text: str, target: str) -> str:
    last_error: Exception | None = None
    for attempt in range(1, REMOTE_ATTEMPTS + 1):
        try:
            return _translate_once(text, target)
        except Exception as err:  # noqa: BLE001
            last_error = err
            if attempt < REMOTE_ATTEMPTS:
                time.sleep(RETRY_BASE_S * attempt)
    raise last_error if last_error else RuntimeError("translate failed")


def resolve_names(name: str, provided: dict | None = None) -> dict:
    """Return the native names, translating anything not given by hand."""
    provided = provided or {}
    base = {"hi": ""}
    for lang in TRANSLATE_LANGS:
        given = str(provided.get(lang) or "").strip()
        if given:
            base[lang] = given
            continue
        if _remote_disabled():
            base[lang] = name
            continue
        try:
            base[lang] = _translate_text(name, lang)
        except Exception as err:  # noqa: BLE001
            print(f"translate fallback {lang}: {err}")
            base[lang] = name
    return base


def regenerate_names(name: str, current: dict) -> dict:
    """Re-resolve names, keeping any native name that already differs."""
    requested: dict = {}
    trimmed = name.strip()
    for lang in TRANSLATE_LANGS:
        value = str(current.get(lang) or "").strip()
        if value and value != trimmed:
            requested[lang] = value
    return resolve_names(name, requested)


def _fetch_mp3(text: str, lang: str) -> bytes:
    url = (
        "https://translate.googleapis.com/translate_tts"
        f"?ie=UTF-8&client=gtx&tl={lang}&q={urllib.parse.quote(text)}"
    )
    status, body, content_type = _http_get(url)
    if status != 200 or len(body) < 2000 or "audio" not in content_type:
        raise RuntimeError(
            f"bad tts http={status} type={content_type} bytes={len(body)}"
        )
    return body


def _download_mp3(text: str, lang: str, file_path) -> None:
    last_error: Exception | None = None
    for attempt in range(1, REMOTE_ATTEMPTS + 1):
        try:
            data = _fetch_mp3(text, lang)
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_bytes(data)
            return
        except Exception as err:  # noqa: BLE001
            last_error = err
            if attempt < REMOTE_ATTEMPTS:
                time.sleep(RETRY_BASE_S * attempt)
    raise last_error if last_error else RuntimeError("tts failed")


def download_item_audio(slug: str, names: dict) -> None:
    """Download one MP3 per language. Failures are logged, never raised."""
    if _remote_disabled():
        return
    for lang in LANGUAGES:
        file_path = TTS_DIR / lang / f"{slug}.mp3"
        text = names.get(lang) or names.get("en") or slug
        try:
            _download_mp3(text, lang, file_path)
            print(f"TTS OK  {lang}/{slug}")
        except Exception as err:  # noqa: BLE001
            print(f"TTS FAIL {lang}/{slug}: {err}")
        time.sleep(0.3)


def delete_item_audio(slug: str) -> None:
    for lang in LANGUAGES:
        try:
            (TTS_DIR / lang / f"{slug}.mp3").unlink(missing_ok=True)
        except OSError:
            pass

# ===========================================================================
# Item photos  (was item_images.py)
# ===========================================================================

import base64
import binascii
import os
import secrets
from urllib.parse import unquote_to_bytes
from pathlib import Path


ITEM_IMAGES_DIR = STORAGE_DIR / "item-images"
ITEM_IMAGES_URL = "/item-images"

MAX_IMAGE_BYTES = 4 * 1024 * 1024


def ensure_item_images_dir() -> None:
    ITEM_IMAGES_DIR.mkdir(parents=True, exist_ok=True)


def _is_jpeg(b: bytes) -> bool:
    return len(b) >= 3 and b[0] == 0xFF and b[1] == 0xD8 and b[2] == 0xFF


def _is_png(b: bytes) -> bool:
    return b[:8] == b"\x89PNG\r\n\x1a\n"


def _is_webp(b: bytes) -> bool:
    return b[:4] == b"RIFF" and b[8:12] == b"WEBP"


def _is_gif(b: bytes) -> bool:
    return b[:6] in (b"GIF89a", b"GIF87a")


_SIGNATURES = [
    ("jpg", _is_jpeg),
    ("png", _is_png),
    ("webp", _is_webp),
    ("gif", _is_gif),
]


def decode_image_data_url(data_url: object) -> tuple[bytes, str]:
    """Decode a ``data:`` URL into bytes plus the detected extension."""
    if not isinstance(data_url, str) or not data_url.startswith("data:image/"):
        raise http_error(400, "Image must be sent as a data: URL")
    comma = data_url.find(",")
    if comma < 0:
        raise http_error(400, "Malformed image data")

    header = data_url[:comma]
    payload = data_url[comma + 1 :]
    try:
        if ";base64" in header:
            raw = base64.b64decode(payload, validate=False)
        else:
            raw = unquote_to_bytes(payload)
    except (binascii.Error, ValueError):
        raise http_error(400, "Malformed image data")

    if len(raw) == 0:
        raise http_error(400, "Image is empty")
    if len(raw) > MAX_IMAGE_BYTES:
        raise http_error(400, f"Image is larger than {MAX_IMAGE_BYTES // 1024 // 1024} MB")

    for ext, test in _SIGNATURES:
        if test(raw):
            return raw, ext
    raise http_error(400, "Image must be a JPEG, PNG, WebP or GIF file")


def _slugify_for_file(text: str) -> str:
    import re

    slug = re.sub(r"\s+", "-", str(text).lower().strip())
    slug = re.sub(r"[^a-z0-9-]", "", slug)
    slug = re.sub(r"-+", "-", slug).strip("-")
    return slug or "item"


def save_item_image(slug: str, data: bytes, ext: str) -> str:
    """Write the bytes under a random name and return the public path."""
    ensure_item_images_dir()
    safe_slug = _slugify_for_file(slug)
    file_name = f"{safe_slug}-{secrets.token_hex(6)}.{ext}"
    (ITEM_IMAGES_DIR / file_name).write_bytes(data)
    return f"{ITEM_IMAGES_URL}/{file_name}"


def delete_item_image(stored_path: object) -> None:
    """Remove a stored picture. A missing file is not an error."""
    if not isinstance(stored_path, str) or not stored_path:
        return
    file_name = os.path.basename(stored_path)
    if not file_name or file_name in (".", ".."):
        return
    try:
        (ITEM_IMAGES_DIR / file_name).unlink(missing_ok=True)
    except OSError:
        pass

# ===========================================================================
# Scale service  (was scale.py)
# ===========================================================================

import json
import threading
import time
from datetime import datetime, timezone
from typing import Callable


try:  # pyserial is optional at import time so the API still boots without it.
    import serial  # type: ignore
    from serial.tools import list_ports as serial_list_ports  # type: ignore

    _HAS_SERIAL = True
except Exception:  # noqa: BLE001
    serial = None  # type: ignore
    serial_list_ports = None  # type: ignore
    _HAS_SERIAL = False


YAOHUA_FRAME_LENGTH = 8
YAOHUA_START_CHAR = "="

SUPPORTED_BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200]

# How long a frame stays believable after it arrives.
READING_MAX_AGE_MS = 2000
STABLE_SAMPLES = 3
MAX_BUFFER_LENGTH = 512
RECONNECT_MS = 2000

DEFAULT_SCALE_PORT = "/dev/ttyS1"


def parse_yaohua_frame(frame: str | None) -> float | None:
    """Parse a single YH-T7E frame into kilograms, or None for noise.

    A frame is 8 characters: '=' followed by 6 reversed digits (decimal point
    included) and a sign character last ('-' means negative).
    """
    if not frame or len(frame) < YAOHUA_FRAME_LENGTH:
        return None
    if frame[0] != YAOHUA_START_CHAR:
        return None
    payload = frame[1:YAOHUA_FRAME_LENGTH]
    sign_char = payload[-1]
    digit_part = payload[:-1]
    normal_order = digit_part[::-1]
    try:
        value = float(normal_order)
    except (TypeError, ValueError):
        return None
    import math

    if not math.isfinite(value):
        return None
    return -value if sign_char == "-" else value


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class ScaleService:
    """Reads the scale and publishes its live reading to subscribers."""

    def __init__(self, port_path: str | None = None, baud_rate: int | None = None) -> None:
        persisted = self._load_persisted()
        import os

        self.port_path = (
            port_path
            or os.environ.get("SCALE_PORT")
            or persisted.get("port")
            or DEFAULT_SCALE_PORT
        )
        self.baud_rate = int(
            baud_rate
            or os.environ.get("SCALE_BAUD_RATE")
            or persisted.get("baudRate")
            or 9600
        )
        raw_interval = os.environ.get("SCALE_POLL_INTERVAL_MS", "100")
        try:
            self.poll_interval_ms = int(raw_interval)
        except ValueError:
            self.poll_interval_ms = 100
        self.poll_byte = os.environ.get("SCALE_POLL_BYTE", "?").encode("ascii", "ignore") or b"?"

        self._status = "stopped"
        self._message: str | None = None
        self._since: str | None = None
        self._reading: dict | None = None
        self._recent_samples: list[float] = []
        self._bytes_received = 0
        self._buffer = ""
        self._started = False
        self._ser = None
        self._worker: threading.Thread | None = None
        self._poll_thread: threading.Thread | None = None
        self._lock = threading.RLock()
        self._status_listeners: list[Callable[[dict], None]] = []
        self._reading_listeners: list[Callable[[dict], None]] = []

    # -- persisted config --------------------------------------------------

    def _load_persisted(self) -> dict:
        try:
            return json.loads(CONFIG.scale_config_file.read_text("utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def _persist_config(self) -> None:
        try:
            CONFIG.scale_config_file.write_text(
                json.dumps({"port": self.port_path, "baudRate": self.baud_rate}, indent=2),
                "utf-8",
            )
        except OSError as err:
            print(f"Could not persist scale config: {err}")

    # -- listeners ---------------------------------------------------------

    def on_status(self, listener: Callable[[dict], None]) -> None:
        with self._lock:
            self._status_listeners.append(listener)

    def off_status(self, listener: Callable[[dict], None]) -> None:
        with self._lock:
            if listener in self._status_listeners:
                self._status_listeners.remove(listener)

    def on_reading(self, listener: Callable[[dict], None]) -> None:
        with self._lock:
            self._reading_listeners.append(listener)

    def off_reading(self, listener: Callable[[dict], None]) -> None:
        with self._lock:
            if listener in self._reading_listeners:
                self._reading_listeners.remove(listener)

    def _emit_status(self) -> None:
        payload = self.get_status()
        for listener in list(self._status_listeners):
            try:
                listener(payload)
            except Exception:  # noqa: BLE001
                pass

    def _emit_reading(self, reading: dict) -> None:
        for listener in list(self._reading_listeners):
            try:
                listener(reading)
            except Exception:  # noqa: BLE001
                pass

    # -- lifecycle ---------------------------------------------------------

    @property
    def is_running(self) -> bool:
        return self._started

    def start(self) -> None:
        with self._lock:
            if self._started:
                return
            self._started = True
        self._worker = threading.Thread(target=self._run, name="scale-worker", daemon=True)
        self._worker.start()

    def stop(self) -> None:
        with self._lock:
            self._started = False
        self._close_port()
        self._reset_stream()
        self._set_status("stopped", "Scale service stopped")

    def configure(self, port_path: str | None = None, baud_rate: int | None = None) -> dict:
        with self._lock:
            next_path = port_path or self.port_path
            next_baud = int(baud_rate) if baud_rate else self.baud_rate
            changed = next_path != self.port_path or next_baud != self.baud_rate
            self.port_path = next_path
            self.baud_rate = next_baud
        self._persist_config()
        if changed:
            self._reset_stream()
            if self._started:
                # The worker will pick the new port up on its next loop.
                self._close_port()
            else:
                self._set_status("stopped", "Scale service stopped")
        return self.get_status()

    # -- status ------------------------------------------------------------

    def get_status(self) -> dict:
        with self._lock:
            return {
                "status": self._status,
                "port": self.port_path,
                "baudRate": self.baud_rate,
                "message": self._message,
                "since": self._since,
                "bytesReceived": self._bytes_received,
                "pollIntervalMs": self.poll_interval_ms if self.poll_interval_ms > 0 else 0,
            }

    def public_status(self) -> dict:
        status = self.get_status()
        return {
            "connected": status["status"] == "connected",
            "status": status["status"],
            "port": status["port"],
            "baudRate": status["baudRate"],
            "message": status["message"],
            "since": status["since"],
            "bytesReceived": status["bytesReceived"],
        }

    def get_reading(self) -> dict | None:
        """The latest reading, or None once it is too old to be believable.

        A scale switched into menu mode or unplugged at the far end leaves the
        port open with nothing coming back; the last frame would otherwise be
        served as a live weight forever.
        """
        with self._lock:
            reading = self._reading
        if not reading:
            return None
        try:
            received = datetime.fromisoformat(reading["receivedAt"].replace("Z", "+00:00"))
            age_ms = (datetime.now(timezone.utc) - received).total_seconds() * 1000
        except Exception:  # noqa: BLE001
            return None
        if age_ms > READING_MAX_AGE_MS:
            return None
        return reading

    def snapshot(self) -> dict:
        return {"status": self.public_status(), "reading": self.get_reading()}

    def list_ports(self) -> list[str]:
        if not _HAS_SERIAL or serial_list_ports is None:
            return []
        try:
            return [p.device for p in serial_list_ports.comports() if p.device]
        except Exception as err:  # noqa: BLE001
            print(f"Serial port discovery failed: {err}")
            return []

    # -- internals ---------------------------------------------------------

    def _set_status(self, status: str, message: str | None) -> None:
        with self._lock:
            self._status = status
            self._message = message
            self._since = _iso_now() if status == "connected" else None
        self._emit_status()

    def _reset_stream(self) -> None:
        with self._lock:
            self._buffer = ""
            self._reading = None
            self._recent_samples = []
            self._bytes_received = 0

    def _close_port(self) -> None:
        with self._lock:
            ser = self._ser
            self._ser = None
        if ser is not None:
            try:
                ser.close()
            except Exception:  # noqa: BLE001
                pass

    def _run(self) -> None:
        while self.is_running:
            self._open_once()
            if not self.is_running:
                break
            time.sleep(RECONNECT_MS / 1000)
        # Loop exits when stopped.

    def _open_once(self) -> None:
        if not _HAS_SERIAL or serial is None:
            self._set_status(
                "failed", "Scale not available. Check the cable and rescan."
            )
            print("Scale port error: the pyserial package is not installed")
            return

        self._close_port()
        with self._lock:
            self._buffer = ""
            self._reading = None
            self._recent_samples = []
            path = self.port_path
            baud = self.baud_rate

        self._set_status("connecting", f"Opening {path} at {baud} baud…")
        try:
            ser = serial.Serial(path, baud, timeout=0.2)
        except Exception as err:  # noqa: BLE001
            self._reset_stream()
            print(f"Scale port error: {err}")
            self._set_status("failed", "Scale not available. Check the cable and rescan.")
            return

        with self._lock:
            self._ser = ser
        self._set_status("connected", None)

        # Poll the device on a fixed cadence while the port is open.
        poll_stop = threading.Event()
        self._poll_thread = threading.Thread(
            target=self._poll_loop, args=(ser, poll_stop), name="scale-poll", daemon=True
        )
        self._poll_thread.start()

        try:
            while self.is_running:
                with self._lock:
                    current = self._ser
                if current is None:
                    break
                try:
                    chunk = current.read(64)
                except Exception as err:  # noqa: BLE001
                    print(f"Scale read error: {err}")
                    break
                if chunk:
                    self._on_data(chunk)
                else:
                    # No bytes yet; keep the loop responsive to stop().
                    time.sleep(0.02)
        finally:
            poll_stop.set()
            self._close_port()
            self._reset_stream()
            if self.is_running:
                self._set_status("reconnecting", f"Waiting for {self.port_path}…")

    def _poll_loop(self, ser, poll_stop: threading.Event) -> None:
        if not self.poll_interval_ms or self.poll_interval_ms <= 0:
            return
        interval = self.poll_interval_ms / 1000
        while not poll_stop.is_set() and self.is_running:
            try:
                ser.write(self.poll_byte)
            except Exception:  # noqa: BLE001
                return
            poll_stop.wait(interval)

    def _on_data(self, chunk: bytes) -> None:
        with self._lock:
            self._bytes_received += len(chunk)
            self._buffer += chunk.decode("ascii", "ignore")
            if len(self._buffer) > MAX_BUFFER_LENGTH:
                self._buffer = self._buffer[-MAX_BUFFER_LENGTH:]
            buffer = self._buffer

        if YAOHUA_START_CHAR not in buffer:
            # No frame start in sight: keep a short tail so a '=' split across
            # two chunks is still caught, and drop the rest as junk.
            with self._lock:
                if len(self._buffer) > 32:
                    self._buffer = self._buffer[-16:]
            return

        while True:
            with self._lock:
                buffer = self._buffer
            if YAOHUA_START_CHAR not in buffer:
                return
            start = buffer.index(YAOHUA_START_CHAR)
            if len(buffer) - start < YAOHUA_FRAME_LENGTH:
                return
            frame = buffer[start : start + YAOHUA_FRAME_LENGTH]
            with self._lock:
                self._buffer = self._buffer[start + YAOHUA_FRAME_LENGTH :]
            weight = parse_yaohua_frame(frame)
            if weight is not None:
                self._push_reading(weight, frame)

    def _push_reading(self, weight: float, raw: str) -> None:
        rounded = _round3(weight)
        with self._lock:
            self._recent_samples.append(rounded)
            if len(self._recent_samples) > STABLE_SAMPLES:
                self._recent_samples.pop(0)
            stable = (
                len(self._recent_samples) >= STABLE_SAMPLES
                and all(sample == rounded for sample in self._recent_samples)
            )
            self._reading = {
                "weight": rounded,
                "raw": raw,
                "receivedAt": _iso_now(),
                "stable": stable,
            }
            reading = dict(self._reading)
        self._emit_reading(reading)


class DisabledScaleService(ScaleService):
    """A service that never opens a port; used when SCALE_ENABLED=0."""

    def start(self) -> None:  # pragma: no cover - trivial
        self._set_status("stopped", "Scale support is disabled (SCALE_ENABLED=0)")

    def configure(self, port_path: str | None = None, baud_rate: int | None = None) -> dict:
        return super().configure(port_path, baud_rate)


def create_scale_service(enabled: bool = True) -> ScaleService:
    if enabled:
        return ScaleService()
    return DisabledScaleService()


def create_scale_stream_handler(service: ScaleService):
    """Return a Flask response that streams status and readings as SSE."""

    def handler() -> object:
        from flask import Response, stream_with_context

        def generate():
            import json as _json

            # Paint the current state immediately so the client is never blank.
            yield f"event: status\ndata: {_json.dumps(service.public_status())}\n\n"
            snapshot = service.get_reading()
            if snapshot:
                yield f"event: reading\ndata: {_json.dumps(snapshot)}\n\n"

            import queue

            events: "queue.Queue[tuple[str, dict]]" = queue.Queue()

            def on_status(status: dict) -> None:
                events.put(("status", service.public_status()))

            def on_reading(reading: dict) -> None:
                events.put(("reading", reading))

            service.on_status(on_status)
            service.on_reading(on_reading)
            try:
                while True:
                    try:
                        kind, payload = events.get(timeout=15)
                        yield f"event: {kind}\ndata: {_json.dumps(payload)}\n\n"
                    except queue.Empty:
                        # Heartbeat keeps proxies and browsers from closing an
                        # idle stream.
                        yield ": keep-alive\n\n"
            finally:
                service.off_status(on_status)
                service.off_reading(on_reading)

        return Response(
            stream_with_context(generate()),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    return handler
