from playwright.sync_api import sync_playwright

CASES = [
    ("land_1280x800", 1280, 800),
    ("land_1920x1080", 1920, 1080),
    ("port_1080x1920  <- your 32\" kiosk", 1080, 1920),
    ("port_1440x2560", 1440, 2560),
    ("port_2160x3840  <- 4K portrait", 2160, 3840),
]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for name, w, h in CASES:
        ctx = browser.new_context(viewport={"width": w, "height": h})
        page = ctx.new_page()
        page.goto("http://localhost:3001/staff/", wait_until="networkidle")
        page.locator("[data-action='select-formula']").first.click()
        page.wait_for_timeout(400)
        page.locator("[data-action='confirm-batches']").click()
        page.wait_for_timeout(700)
        m = page.evaluate("""() => ({
            fit: getComputedStyle(document.documentElement)
                .getPropertyValue('--screen-fit').trim(),
            root: getComputedStyle(document.documentElement).fontSize,
            lcd: getComputedStyle(
                document.querySelector('.scale-reading')).fontSize,
            itemName: getComputedStyle(
                document.querySelector('.current-item-name')).fontSize,
        })""")
        print(f"{name}: fit={m['fit']} root={m['root']} LCD={m['lcd']} item={m['itemName']}")
        ctx.close()
    browser.close()
