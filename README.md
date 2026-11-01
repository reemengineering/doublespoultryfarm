# DOUBLES POULTRY FARM — Weighing Terminal

A self-hosted weighing terminal for the shop floor: a live scale readout, an
item master, reusable formulas, a guided weighing workflow, and production
reports — all in one Python process, with a touch-friendly browser UI.

The system is a Python/Flask port of the original TypeScript terminal. The
behaviour is the same; the stack is not. There is no Node.js, no build step and
no database server to install: one `python app.py` serves the API, the UI and
the scale connection.

---

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Running the terminal](#running-the-terminal)
  - [Start the server](#start-the-server)
  - [Open the terminal](#open-the-terminal)
  - [Connect the scale](#connect-the-scale)
  - [Weigh a batch](#weigh-a-batch)
  - [Printing](#printing)
  - [Text size](#text-size)
  - [Stopping](#stopping)
- [Configuration](#configuration)
- [Data and storage](#data-and-storage)
- [The scale](#the-scale)
- [Two terminals: kiosk and staff](#two-terminals-kiosk-and-staff)
- [The weighing rules](#the-weighing-rules)
- [Project layout](#project-layout)
- [HTTP API](#http-api)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)

---

## What it does

- **Weighing workflow** — queue items with a target weight, then weigh them one
  at a time against the live scale. Each line is judged *accepted*,
  *underweight* or *overweight*, and an accepted line advances on its own.
- **Live scale readout** — the terminal polls a YAOHUA (YH-T7E) indicator over a
  serial port and streams the weight to the browser over Server-Sent Events.
- **Item master** — items carry an auto code (`RM-01`, `RM-02`, …), an optional
  photo and optional Hindi/Bengali/Tamil names for spoken prompts.
- **Formulas** — name a recipe and list its ingredients and target weights; load
  the whole recipe into the weighing queue with one tap.
- **History** — every saved weighing (batch `WS-00001`, `WS-00002`, …) is kept
  with its lines and can be reopened and printed.
- **Reports** — overview, monthly, daily and yearly production summaries, with
  CSV export.
- **Resilience** — if the app is reloaded mid-weighing the queue is restored and
  lines already weighed stay marked complete. If a save is interrupted the bill
  is held and retried rather than lost.

## Requirements

- Python 3.10 or newer (developed on 3.12).
- The two dependencies in `requirements.txt`: Flask and pyserial.
- A YAOHUA YH-T7E compatible scale on a serial port (optional — everything
  except live weighing works without one).

## Quick start

Windows:

```bat
run.bat
```

Linux / macOS:

```bash
./run.sh
```

Both scripts create a virtual environment, install the requirements and start
the server. To run it by hand:

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # Windows
.venv/bin/python  -m pip install -r requirements.txt      # Linux/macOS
python app.py
```

Then open **http://localhost:3001** in a browser on the terminal machine (or any
machine on the same network, using the terminal's address).

## Running the terminal

The short operational guide: how to start it, how to wire up the scale and the
printer, and what to try when something is not working.

### Start the server

On the terminal machine, from the project folder, run `run.bat` (Windows) or
`./run.sh` (Linux/macOS). The first run creates a `.venv` and installs Flask and
pyserial; later runs start almost immediately. When it is up you will see:

```
DOUBLES POULTRY FARM weighing server
Listening on http://localhost:3001
Database: D:\REMAN Projects\Doubles Poultry Farm\data\reem.db
```

Leave that window open — closing it stops the terminal.

### Open the terminal

On the same machine, open a browser at:

```
http://localhost:3001          the full terminal (weighing, formulas, items, history, reports)
http://localhost:3001/staff/   the shop-floor station (weighing only)
```

To reach it from another machine on the same network, replace `localhost` with
the terminal machine's address (for example `http://192.168.1.20:3001`). If the
browser cannot connect, see *Troubleshooting* below.

### Connect the scale

1. Plug the scale's serial lead into the terminal machine and switch the scale
   on.
2. In the header, tap **SCALE**. Pick the port and the baud rate, then connect.
   On Windows the port looks like `COM3`; on Linux, `/dev/ttyS1` or `/dev/ttyUSB0`.
3. The header chip changes from **SCALE OFFLINE** and the readout starts
   tracking the pan. Put a known weight on the pan to confirm the number.

The chosen port is remembered, so the next start reconnects to the same one.

If this machine has no scale (an office or reporting desk), start it with the
scale switched off instead:

```bat
set SCALE_ENABLED=0
python app.py
```

### Weigh a batch

1. On the **WEIGHING** screen, tap an item from the catalogue, type the target
   weight, and **ADD TO QUEUE**. Repeat for each line, or load a saved formula
   from the **FORMULAS** section on the same screen.
2. Tap **START WEIGHING**. The terminal shows the live reading and the verdict
   for the first line.
3. Fill the pan until the verdict reads **WEIGHT ACCEPTED**. The line is saved
   and the terminal moves to the next one by itself (you can also press
   **NEXT**).
4. When the last line is done the batch is saved automatically and you get a
   bill with its batch number (`WS-00001`, `WS-00002`, …).

Items that cannot be weighed now can be skipped; the line is recorded with no
actual weight.

### Printing

Open a saved batch from **HISTORY** and tap **PRINT BILL**, then print from the
browser's print dialog. The printed page shows the DOUBLES POULTRY FARM
heading, the batch number and the line weights. Set the browser's margins to
*Default* and leave headers/footers off for the cleanest result.

### Text size

The header's **A** button cycles the text size (small → medium → large → extra
large). The choice is remembered on that browser.

### Stopping

Close the server window (or press Ctrl+C in it). To stop the machine from the UI
itself, open **SERVER** and use **Power**; it asks for confirmation first.

## Configuration

Everything is optional and read from the environment. Copy the values you need
into the run script or set them before `python app.py`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port. |
| `HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` to keep it on this machine only. |
| `DATA_DIR` | `./data` | Where the database, config and storage live. |
| `DB_PATH` | `data/reem.db` | The SQLite file, if you want it somewhere else. |
| `SCALE_ENABLED` | `1` | `0` keeps the scale reader dormant (useful for office/desk use). |
| `SCALE_PORT` | `/dev/ttyS1` | Default serial port. On Windows, e.g. `COM3`. |
| `SCALE_BAUD_RATE` | `9600` | Default baud rate. |
| `SCALE_POLL_INTERVAL_MS` | `100` | How often the scale is polled. |
| `SCALE_POLL_BYTE` | `?` | The byte written to request a reading. |
| `REEM_DISABLE_REMOTE` | *(unset)* | `1` disables outbound translation and speech calls (offline installs). |
| `CORS_ORIGIN` | *(empty)* | Comma-separated extra browser origins allowed to call the API. |
| `SECRET_KEY` | *(built in)* | Flask session key; set your own in production. |

## Data and storage

Everything the shop owns lives under `DATA_DIR` (default `./data`) and is not
part of the code, so the application can be replaced wholesale without touching
the records:

```
data/
  reem.db                     SQLite database (items, formulas, weighings)
  scale-config.json           last-used serial port and baud rate
  storage/
    item-images/              item photos (uploaded as data URLs, stored here)
    tts/<language>/           cached voice clips (hi, bn, ta)
```

`data/` is ignored by Git (see `.gitignore`). Back it up by copying the folder.

## The scale

The terminal talks to a YAOHUA YH-T7E compatible indicator. The device is
request/response: it stays silent until a byte is written to it, then answers
with one 8-character frame, e.g. `=052.100` (which reads back as `1.25`). The
server polls it on a fixed cadence while the port is open and forwards each
frame to the browser.

- Open the **SCALE** panel in the header, pick the port and the baud rate, and
  connect. Available ports are listed for you; on a bare Linux install they may
  also be reached directly by name.
- The header chip shows *SCALE OFFLINE* until a port is connected, then the live
  status.
- A frame older than two seconds is treated as stale, so a scale switched into a
  menu or unplugged at the far end shows nothing rather than a frozen weight.

If the scale is not needed on a machine, start it with `SCALE_ENABLED=0`.

## Two terminals: kiosk and staff

The same application serves two entry points:

- **`/`** — the full terminal: weighing, formulas, item master, history and
  reports.
- **`/staff/`** — the same weighing workflow with the administrative screens
  hidden, for a locked-down shop-floor station.

## The weighing rules

The shop's rule is on the last digit and always rounds **down**:

- A target of `50.8 kg` is weighed as `50 kg`; `0.4 kg` is lifted to `1 kg` (a
  zero target cannot be weighed).
- A reading is accepted anywhere from the target up to the target plus `0.999 kg`
  — a `50 kg` target is met by anything from `50.000` to `50.999`.
- The stored actual weight is rounded down the same way, so `51.2 kg` on the pan
  reads as `51 kg`.

The scale is never re-zeroed between lines: whatever it read when a line started
is held as the zero point, so each line is measured against itself.

## Project layout

The project is deliberately small — one Python package, three browser modules
and one page, so there is no build step and nothing to keep in sync.

```
app.py                 Entry point.
run.bat / run.sh       One-command launchers.
requirements.txt       Flask and pyserial.
templates/index.html   The page both terminals render.
static/
  css/app.css          The whole theme (the staff rules are scoped under .page-staff).
  js/
    lib.js             Shared modules: constants, weights, tare, storage,
                       alerts, speech, photos, the API client and the scale.
    app.js             The kiosk front end.
    staff.js           The staff front end.
reem/
  __init__.py          Application factory and every REST endpoint.
  domain.py            Settings, the weighing rules, speech, photos and the scale service.
  store.py             SQLite schema, migrations, seeding and queries.
tests/test_reem.py     The whole unittest suite.
```

## HTTP API

All endpoints live under `/api` and speak JSON. Errors are JSON too, so the
browser never has to parse an HTML error page.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness and version. |
| `GET` | `/api/items` | Item master. |
| `POST` | `/api/items` | Create an item. |
| `POST` | `/api/items/<id>/regenerate` | Regenerate an item's code and photo. |
| `POST` | `/api/items/<id>/image` | Set an item photo (data URL). |
| `DELETE` | `/api/items/<id>/image` | Clear an item photo. |
| `DELETE` | `/api/items/<id>` | Delete an item (refused if a formula uses it). |
| `GET` | `/api/formulas` | Formulas. |
| `POST` | `/api/formulas` | Create a formula. |
| `PUT` | `/api/formulas/<id>` | Update a formula. |
| `DELETE` | `/api/formulas/<id>` | Delete a formula. |
| `POST` | `/api/weighings` | Save a weighing (de-duplicated by `ref`). |
| `GET` | `/api/weighings?limit=` | Recent weighings (limit clamped to 1–500). |
| `GET` | `/api/weighings/<id>` | One weighing with its lines. |
| `GET` | `/api/reports/overview` | Last twelve months. |
| `GET` | `/api/reports/monthly?year=&month=` | One month. |
| `GET` | `/api/reports/daily?date=` | One day. |
| `GET` | `/api/reports/yearly?year=` | One year, month by month. |
| `GET` | `/api/scale/ports` | Serial ports and whether the scale is enabled. |
| `GET` | `/api/scale/status` | Current scale status and reading. |
| `GET` | `/api/scale/stream` | Server-Sent Events: status and live readings. |
| `POST` | `/api/scale/connect` | Open a port. |
| `POST` | `/api/scale/disconnect` | Close the port. |
| `POST` | `/api/shutdown` | Stop the host (requires confirmation). |

## Tests

The suite uses `unittest`, runs against a throwaway database and makes no
network calls:

```bash
python -m unittest discover -s tests -t .
```

It covers the rounding and verdict rules, the tare zero point, the YH-T7E frame
parser and stream buffering, the full API flow (items, formulas, weighings,
de-duplication, validation, reports, scale, shutdown) and that the two pages and
their assets are served.

## Troubleshooting

**The browser cannot reach the terminal.**
Check the server window is still open and shows the *Listening on* line. Confirm
the address and port match `PORT` (default `3001`). On another machine, check the
firewall allows the port; binding only to this machine (`HOST=127.0.0.1`) blocks
other machines by design.

**The scale chip stays offline.**
Make sure the lead is fully seated and the scale is on. Open **SCALE** and
rescan; the correct port appears when the device is present. Check the baud rate
matches the scale (9600 is the usual setting). A wrong port or baud rate shows as
*Scale not available* — pick another and reconnect.

**The reading freezes or reads zero.**
The scale may be in a menu or calibration mode; return it to weighing mode. A
frame older than two seconds is deliberately ignored, so a frozen number stays
blank rather than showing a stale weight.

**Reports are empty.**
Reports bucket by the date each batch was saved. Check the month, day or year in
the report's controls, and confirm the batch appears under **HISTORY**.

**Speech or translated names are missing.**
Voice prompts are generated once and cached under `data/storage/tts/`. On a
machine with no internet the first generation cannot happen; set
`REEM_DISABLE_REMOTE=1` to skip the attempt, or connect it to the network once to
fill the cache.

**Starting over.**
The shop's records are entirely in `data/`. To take a backup, copy that folder.
To start fresh, stop the server, rename or delete `data/`, and start again — the
item master is re-seeded automatically.
