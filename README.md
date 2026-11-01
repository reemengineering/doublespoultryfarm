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
- [Kiosk mode](#kiosk-mode)

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

- Windows (the kiosk-mode scripts are Windows-only; the server itself also runs
  on Linux/macOS).
- Python 3.10 or newer (developed on 3.12).
- The dependencies in `requirements.txt`: Flask, requests and pyserial.
- A YAOHUA YH-T7E compatible scale on a serial port (optional — everything
  except live weighing works without one).

## Quick start

```bat
run.bat
```

The script checks that Python and the required packages are present (installing
them on the first run) and starts the server:

```
DOUBLES POULTRY FARM weighing server
Listening on http://localhost:3001
```

Then open the browser on the terminal machine:

```
http://localhost:3001          the full terminal (weighing, formulas, items, history, reports)
http://localhost:3001/staff/   the shop-floor station (weighing only)
```

To run it by hand instead:

```
python -m pip install -r requirements.txt
python app.py
```

## Kiosk mode

On the shop-floor terminal the application should start by itself, fill the
whole screen and lock the machine down — that is what the kiosk scripts do.
There is a one-time install; after that every sign-in starts the terminal
automatically.

### One-time setup

Create a dedicated **Kiosk** user (Standard user, not administrator), sign in
as that user, and double-click:

```bat
install-kiosk.bat
```

It needs no administrator rights. It places a shortcut to `kiosk-start.vbs` in
the Kiosk account's Startup folder and locks the account down: the Windows key,
Win+R, right-click menus, Task Manager, Command Prompt and other escape routes
are disabled for that account only. See `SETUP-ON-TARGET-PC.txt` for the full
step-by-step (including optional auto sign-in so the terminal boots straight
into the shop-floor screen).

### What happens at every sign-in

The Startup entry runs `kiosk-start.vbs`, which:

1. Starts the server hidden (`kiosk-server.bat`), which installs the packages
   on first run, restarts itself if it ever stops, and serves
   `http://localhost:3001/staff/` — the staff-only weighing station.
2. Starts the keyboard filter (`kiosk-keys.py`), which blocks Alt+Tab, Alt+F4
   and other shortcuts while leaving typing, Enter/Tab/arrows and Ctrl+Alt+A
   working.
3. Opens Microsoft Edge in full-screen kiosk mode on
   `http://localhost:3001/staff/`.
4. Keeps a watchdog running: if Edge or the keyboard filter is closed, they
   reopen on their own.

### Day-to-day

- **Start manually** (without a restart): double-click `kiosk-start.vbs`.
- **Exit the terminal**: Ctrl+Alt+Del → Sign out (this is the only way out).
- **Stop just the server**: close its hidden window via Task Manager from an
  administrator account, or sign out.

The full weighing terminal (items, formulas, history, reports) is still
reachable at `http://localhost:3001/` from any other machine on the network —
open the browser there and point it at the terminal machine's address.
