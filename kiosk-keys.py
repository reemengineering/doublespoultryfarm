#!/usr/bin/env python3
"""
DOUBLES POULTRY FARM - kiosk keyboard filter.

Runs hidden in the Kiosk account (started by kiosk-start.vbs) and swallows
shortcut keys that would break out of kiosk mode:

  blocked : Alt+Tab, Alt+F4, Alt+Esc, Alt+Space, every other Alt-combo,
            Windows key / right-click key, Ctrl+Esc, Ctrl+Shift+Esc
  allowed : Ctrl+Alt+A (terminal switch), normal letters, digits, Enter,
            Tab, Backspace, arrows, Shift, Ctrl, Alt (alone)
  Ctrl+Alt+Del always passes - Windows handles it before any hook can
  see it, so it stays as the way to sign out.

Design notes (do not "simplify" these away):
  * CallNextHookEx/GetAsyncKeyState/etc. have explicit argtypes. Without
    them ctypes chokes on the 64-bit lParam and every PASSING key raised
    an exception inside the callback - which Windows turned into an
    undefined return value and, depending on the Python build, swallowed
    the whole keyboard. That was the "keyboard completely blocked" bug.
  * Alt/Ctrl state comes from the actual key events themselves (down/up
    of Ctrl/Alt), ORed with the LLKHF_ALTDOWN flag of the current event.
    GetAsyncKeyState reads as 0 inside a hook, so it is only a bonus.
  * A stuck state can never kill typing for long: an Alt/Ctrl held "for
    more than 2 minutes" is auto-reset (nobody holds Alt for 2 minutes
    in a weighing app).
  * The callback fails OPEN: if anything raises, the key passes through
    and the error is written to --log. Never swallow on error.
  * Keep the callback fast - Windows silently removes slow hooks.
"""

import sys
import time
import ctypes
from ctypes import wintypes

user32 = ctypes.windll.user32

WH_KEYBOARD_LL = 13
WM_KEYDOWN, WM_KEYUP = 0x0100, 0x0101
WM_SYSKEYDOWN, WM_SYSKEYUP = 0x0104, 0x0105
LLKHF_ALTDOWN = 0x20          # flags bit: Alt was held when this event happened
STUCK_RESET_SECONDS = 120     # auto-release a modifier "held" this long

VK = {
    "SHIFT": 0x10, "CONTROL": 0x11, "MENU": 0x12,
    "ESCAPE": 0x1B, "SPACE": 0x20,
    "LWIN": 0x5B, "RWIN": 0x5C, "APPS": 0x5D,
    "LCONTROL": 0xA2, "RCONTROL": 0xA3, "LMENU": 0xA4, "RMENU": 0xA5,
    "A": 0x41,
}
MODIFIERS = {VK["SHIFT"], VK["CONTROL"], VK["MENU"],
             VK["LCONTROL"], VK["RCONTROL"], VK["LMENU"], VK["RMENU"]}
ALT_VKS = {VK["MENU"], VK["LMENU"], VK["RMENU"]}
CTRL_VKS = {VK["CONTROL"], VK["LCONTROL"], VK["RCONTROL"]}

logfile = None   # set by --log FILE: records events, decisions, errors


def log_line(text):
    if not logfile:
        return
    try:
        with open(logfile, "a") as fh:
            fh.write(text + "\n")
    except OSError:
        pass


# ---- tracked modifier state (updated only from real key events) -----------
tracked_alt = False
tracked_ctrl = False
alt_since = 0.0
ctrl_since = 0.0


def _update_tracker(vk, down, now):
    global tracked_alt, tracked_ctrl, alt_since, ctrl_since
    if vk in ALT_VKS:
        tracked_alt = down
        alt_since = now
        if not down:
            log_line("state: Alt released")
    elif vk in CTRL_VKS:
        tracked_ctrl = down
        ctrl_since = now


def modifier_state(flags):
    """Alt/Ctrl state for THIS event: tracker + flag + async (best effort)."""
    global tracked_alt, tracked_ctrl
    now = time.monotonic()
    # stuck guards: fail OPEN, never let a lost key-up kill typing forever
    if tracked_alt and now - alt_since > STUCK_RESET_SECONDS:
        tracked_alt = False
        log_line("state: Alt auto-reset (held > %ds)" % STUCK_RESET_SECONDS)
    if tracked_ctrl and now - ctrl_since > STUCK_RESET_SECONDS:
        tracked_ctrl = False
        log_line("state: Ctrl auto-reset (held > %ds)" % STUCK_RESET_SECONDS)
    alt = (tracked_alt
           or bool(flags & LLKHF_ALTDOWN)
           or bool(user32.GetAsyncKeyState(VK["MENU"]) & 0x8000))
    ctrl = (tracked_ctrl
            or bool(user32.GetAsyncKeyState(VK["CONTROL"]) & 0x8000))
    return alt, ctrl


def should_block(vk, alt, ctrl):
    if vk in MODIFIERS:
        return False                      # never eat Ctrl/Alt/Shift themselves
    if vk in (VK["LWIN"], VK["RWIN"], VK["APPS"]):
        return True                       # Windows key, menu key
    if alt:
        return not (ctrl and vk == VK["A"])   # every Alt combo except Ctrl+Alt+A
    if ctrl and vk == VK["ESCAPE"]:
        return True                       # Ctrl+Esc (Start) / Ctrl+Shift+Esc
    return False


# ---- ctypes plumbing (argtypes are mandatory - see header) -----------------
class KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [("vkCode", wintypes.DWORD),
                ("scanCode", wintypes.DWORD),
                ("flags", wintypes.DWORD),
                ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.c_size_t)]


HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_int,
                              wintypes.WPARAM, wintypes.LPARAM)

user32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC,
                                     wintypes.HINSTANCE, wintypes.DWORD]
user32.SetWindowsHookExW.restype = ctypes.c_void_p
user32.UnhookWindowsHookEx.argtypes = [ctypes.c_void_p]
user32.UnhookWindowsHookEx.restype = ctypes.c_int
user32.CallNextHookEx.argtypes = [ctypes.c_void_p, ctypes.c_int,
                                  wintypes.WPARAM, wintypes.LPARAM]
user32.CallNextHookEx.restype = ctypes.c_ssize_t
user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
user32.GetAsyncKeyState.restype = ctypes.c_short


def call_next(nCode, wParam, lParam):
    """Pass the event on. Fail OPEN: never raise inside the callback."""
    try:
        return user32.CallNextHookEx(None, nCode, wParam, lParam)
    except Exception as exc:
        log_line("EXCEPTION in CallNextHookEx %r -> key passed" % (exc,))
        return 0                           # 0 = do not drop the key


def _callback(nCode, wParam, lParam):
    if nCode >= 0:
        try:
            kb = ctypes.cast(lParam, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents
            vk = int(kb.vkCode)
            down = wParam in (WM_KEYDOWN, WM_SYSKEYDOWN)
            up = wParam in (WM_KEYUP, WM_SYSKEYUP)
            if down or up:
                _update_tracker(vk, down, time.monotonic())
                alt, ctrl = modifier_state(int(kb.flags))
                if should_block(vk, alt, ctrl):
                    log_line("vk=0x%02X alt=%d ctrl=%d -> BLOCK"
                             % (vk, alt, ctrl))
                    return 1              # swallow the key
                log_line("vk=0x%02X alt=%d ctrl=%d -> pass"
                         % (vk, alt, ctrl))
        except Exception as exc:          # fail OPEN: never eat a key on error
            log_line("EXCEPTION %r -> key passed" % (exc,))
    return call_next(nCode, wParam, lParam)


def selftest():
    global tracked_alt, tracked_ctrl, alt_since, ctrl_since
    cases = []

    def check(desc, expect, alt, ctrl, vk):
        got = should_block(vk, alt, ctrl)
        cases.append((got == expect, desc, expect, got))

    # normal typing always passes
    check("letter A", False, False, False, VK["A"])
    check("letter x", False, False, False, 0x58)
    check("digit 0", False, False, False, 0x30)
    check("Enter", False, False, False, 0x0D)
    check("Tab (no Alt)", False, False, False, 0x09)
    check("Esc (no Ctrl)", False, False, False, VK["ESCAPE"])
    check("Shift passes", False, False, False, VK["SHIFT"])
    # Windows key blocked
    check("Win key", True, False, False, VK["LWIN"])
    check("Right Win key", True, False, False, VK["RWIN"])
    check("Right-click key", True, False, False, VK["APPS"])
    # Alt combos blocked except Ctrl+Alt+A
    check("Alt+Tab", True, True, False, 0x09)
    check("Alt+F4", True, True, False, 0x73)
    check("Alt+Space", True, True, False, VK["SPACE"])
    check("Alt+Esc", True, True, False, VK["ESCAPE"])
    check("Alt+A (no Ctrl)", True, True, False, VK["A"])
    check("Ctrl+Alt+A", False, True, True, VK["A"])
    check("Alt itself passes", False, True, False, VK["MENU"])
    check("Right Alt passes", False, True, False, VK["RMENU"])
    # Ctrl combos that open shells
    check("Ctrl+Esc", True, False, True, VK["ESCAPE"])
    check("Ctrl+Alt+Tab (Alt held)", True, True, True, 0x09)

    # tracker state machine: press and release, then stuck-guard
    tracked_alt = tracked_ctrl = False
    _update_tracker(VK["LMENU"], True, time.monotonic())
    _update_tracker(VK["LCONTROL"], True, time.monotonic())
    alt, ctrl = modifier_state(0)
    cases.append((alt and ctrl, "tracker: Alt+Ctrl down", True, alt and ctrl))
    _update_tracker(VK["LMENU"], False, time.monotonic())
    _update_tracker(VK["LCONTROL"], False, time.monotonic())
    alt, ctrl = modifier_state(0)
    cases.append((not alt and not ctrl, "tracker: released", True,
                  not alt and not ctrl))
    # stuck guard: Alt "down" for 10 minutes must auto-reset (fail open)
    tracked_alt = True
    alt_since = time.monotonic() - 600
    alt, _ = modifier_state(0)
    cases.append((not alt, "stuck Alt auto-resets", True, not alt))
    tracked_alt = False

    bad = [c for c in cases if not c[0]]
    for ok, desc, expect, got in cases:
        print(("PASS  " if ok else "FAIL  ") + desc +
              "  expected=" + str(expect) + " got=" + str(got))
    print("%d/%d checks passed" % (len(cases) - len(bad), len(cases)))
    return 0 if not bad else 1


def main():
    global logfile
    if "--selftest" in sys.argv:
        return selftest()
    for i, arg in enumerate(sys.argv):
        if arg == "--log" and i + 1 < len(sys.argv):
            logfile = sys.argv[i + 1]

    cb = HOOKPROC(_callback)             # keep a reference (must not be GC'd)
    hook = user32.SetWindowsHookExW(WH_KEYBOARD_LL, cb, None, 0)
    if not hook:
        print("SetWindowsHookEx failed: %d" % ctypes.GetLastError())
        return 1

    if "--smoke" in sys.argv:            # install, live 3 s, report, exit
        time.sleep(3)
        user32.UnhookWindowsHookEx(hook)
        print("hook installed and removed OK")
        return 0

    log_line("filter started")
    msg = wintypes.MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))
    user32.UnhookWindowsHookEx(hook)
    log_line("filter stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
