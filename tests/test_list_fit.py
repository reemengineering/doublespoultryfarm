# Verify the formula-select list now always stays inside the viewport:
# box bottom above footer top, last row reachable by inner scroll, at all sizes.
from playwright.sync_api import sync_playwright

URL = "http://localhost:3001/staff/"
CASES = [
    ("portrait_1080x1920", 1080, 1920),
    ("portrait_720x1280", 720, 1280),
    ("portrait_1440x2560", 1440, 2560),
    ("landscape_1920x1080", 1920, 1080),
    ("landscape_2340x1080", 2340, 1080),
    ("landscape_1280x800", 1280, 800),
]

ok = True
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for name, w, h in CASES:
        ctx = browser.new_context(viewport={"width": w, "height": h})
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(URL, wait_until="networkidle")
        page.evaluate("""() => {
            const scroller = document.querySelector('.staff-list-scroll');
            const row = scroller.querySelector('.staff-row');
            for (let i = 0; i < 18; i++) scroller.appendChild(row.cloneNode(true));
        }""")
        m = page.evaluate(
            """() => {
                const list = document.querySelector('.staff-list-scroll');
                const foot = document.querySelector('.app-footer');
                const lRect = list.getBoundingClientRect();
                const fRect = foot.getBoundingClientRect();
                // scroll to the very end and check the last row is visible
                list.scrollTop = list.scrollHeight;
                const rows = list.querySelectorAll('.staff-row');
                const last = rows[rows.length - 1].getBoundingClientRect();
                return {
                    rootPx: getComputedStyle(document.documentElement).fontSize,
                    listTop: lRect.top,
                    listBottom: lRect.bottom,
                    footTop: fRect.top,
                    fit: getComputedStyle(document.documentElement)
                        .getPropertyValue('--screen-fit').trim(),
                    canScroll: list.scrollHeight > list.clientHeight,
                    scrolledToEnd: Math.abs(
                        (list.scrollTop + list.clientHeight)
                        - list.scrollHeight) < 2,
                    lastRowVisible: last.top >= lRect.top
                        && last.bottom <= Math.min(lRect.bottom + 1, fRect.top),
                    docScrollH: document.documentElement.scrollHeight,
                    innerH: window.innerHeight,
                };
            }"""
        )
        fits = m["listBottom"] <= m["footTop"] + 1
        inside = m["listBottom"] <= m["innerH"] + 1
        status = "OK" if (fits and m["canScroll"] and m["scrolledToEnd"]
                          and m["lastRowVisible"] and inside) else "FAIL"
        if status == "FAIL":
            ok = False
        print(f"{name}: {status}  fit={m['fit']} listBottom={m['listBottom']:.0f}"
              f" footTop={m['footTop']:.0f} innerH={m['innerH']}"
              f" canScroll={m['canScroll']} endReached={m['scrolledToEnd']}"
              f" lastRowVisible={m['lastRowVisible']} errors={errors}")
        ctx.close()
    browser.close()

print("ALL PASS" if ok else "SOME FAILED")
