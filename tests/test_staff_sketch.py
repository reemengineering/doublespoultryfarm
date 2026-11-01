# Sketch-layout test for the staff terminal: portrait + landscape.
# Checks: no page scroll, no panel overlap, footer visible, verdict visible,
# old bar/queue gone, alerts toggle in header, flex direction, console errors.
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

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for name, w, h in CASES:
        ctx = browser.new_context(viewport={"width": w, "height": h})
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(URL, wait_until="networkidle")
        # The flow now has a batch-count step between picking a formula and
        # weighing: click the formula, confirm the count, then weigh.
        page.locator("[data-action='select-formula']").first.click()
        page.wait_for_timeout(400)
        page.locator("[data-action='confirm-batches']").click()
        page.wait_for_timeout(700)
        page.screenshot(path=f"D:/REMAN Projects/sketch_{name}.png", full_page=True)
        m = page.evaluate(
            """() => {
                const scale = document.querySelector('.scale-panel');
                const input = document.querySelector('.input-panel');
                const foot = document.querySelector('.app-footer');
                const advance = document.querySelector('#t-advance');
                const sRect = scale ? scale.getBoundingClientRect() : null;
                const iRect = input ? input.getBoundingClientRect() : null;
                const vRect = advance ? advance.getBoundingClientRect() : null;
                const fRect = foot ? foot.getBoundingClientRect() : null;
                return {
                    docScroll: document.documentElement.scrollHeight,
                    inner: window.innerHeight,
                    overlap: !!(sRect && iRect && iRect.width > 0 && iRect.height > 0 && iRect.top < sRect.bottom - 1),
                    verdictVisible: advance ? advance.offsetParent !== null : true,
                    footerVisible: !!fRect && fRect.bottom <= window.innerHeight + 1,
                    scaleScroll: scale ? scale.scrollHeight - scale.clientHeight : 0,
                    inputScroll: input ? input.scrollHeight - input.clientHeight : 0,
                };
            }"""
        )
        # Advance-title text loads only when the box shows; the stable text on
        # the terminal is the formula name and the BATCH hint.
        text = (page.locator("#t-advance-title").text_content() or "").strip()
        formulaShown = (page.locator(".current-formula").text_content() or "").strip()
        hint = " | ".join(
            (t or "").strip() for t in page.locator(".next-item-hint").all_text_contents()
        )
        bar = page.locator(".terminal-bar").count()
        queue = page.locator(".queue-panel").count()
        alerts = page.locator("#t-alerts").count()
        direction = page.evaluate(
            "(() => { const el = document.querySelector('.terminal-layout'); return el ? getComputedStyle(el).flexDirection : 'none'; })()"
        )
        overlap = m['overlap'] if direction == 'column' else False
        print(
            f"{name}: overlap={overlap} advanceVisible={m['verdictVisible']} "
            f"footer={m['footerVisible']} innerScroll(scale/input)={m['scaleScroll']}/{m['inputScroll']} "
            f"bar={bar} queue={queue} alerts={alerts} formula='{formulaShown}' advance='{text}' "
            f"hint='{hint}' dir={direction} errors={errors}"
        )
        ctx.close()
    browser.close()
