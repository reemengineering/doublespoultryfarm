"""Entry point for the DOUBLES POULTRY FARM weighing terminal.

One process serves the API and the UI on http://localhost:3001:

    python app.py

Environment variables (all optional):

    PORT                 HTTP port (default 3001)
    HOST                 bind address (default 0.0.0.0)
    DB_PATH              SQLite file (default data/reem.db)
    DATA_DIR             runtime data directory (default ./data)
    SCALE_ENABLED        0 keeps the scale reader dormant
    SCALE_PORT           default serial port (default /dev/ttyS1)
    SCALE_BAUD_RATE      default baud rate (default 9600)
    REEM_DISABLE_REMOTE  1 disables outbound translation/TTS calls
    CORS_ORIGIN          comma separated extra allowed browser origins
"""

from __future__ import annotations

import sys

from reem import create_app
from reem.domain import CONFIG


def main() -> int:
    if not (1 <= CONFIG.port <= 65535):
        print(
            f"PORT must be a whole number between 1 and 65535, got {CONFIG.port!r}.",
            file=sys.stderr,
        )
        return 1

    app = create_app()

    print(f"DOUBLES POULTRY FARM weighing server")
    print(f"Listening on http://localhost:{CONFIG.port}")
    print(f"Database: {CONFIG.db_path}")

    try:
        app.run(host=CONFIG.host, port=CONFIG.port, threaded=True, debug=False)
    except OSError as err:
        print(f"Server could not start: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
