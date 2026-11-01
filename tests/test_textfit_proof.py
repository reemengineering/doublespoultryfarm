from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for name, w, h in (("ref_1280x800", 1280, 800), ("big_1920x1080", 1920, 1080)):
        ctx = browser.new_context(viewport={"width": w, "height": h})
        page = ctx.new_page()
        page.goto("http://localhost:3001/staff/", wait_until="networkidle")
        fit = page.evaluate(
            "getComputedStyle(document.documentElement).getPropertyValue('--screen-fit').trim()")
        root = page.evaluate("getComputedStyle(document.documentElement).fontSize")
        title = page.evaluate(
            "getComputedStyle(document.querySelector('.screen-title')).fontSize")
        row = page.evaluate(
            "getComputedStyle(document.querySelector('.staff-row-name')).fontSize")
        print(f"{name}: fit={fit} rootFont={root} title={title} rowName={row}")
        page.screenshot(path=f"D:/REMAN Projects/textfit_{name}.png")
        ctx.close()
    browser.close()
