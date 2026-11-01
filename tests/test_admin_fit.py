from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for name, w, h in (("admin_1280x800", 1280, 800), ("admin_1920x1080", 1920, 1080)):
        ctx = browser.new_context(viewport={"width": w, "height": h})
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto("http://localhost:3001/", wait_until="networkidle")
        page.locator("#pin-input").fill("9876")
        page.keyboard.press("Enter")
        page.wait_for_timeout(600)
        root = page.evaluate("getComputedStyle(document.documentElement).fontSize")
        page.screenshot(path=f"D:/REMAN Projects/fit_{name}.png", full_page=False)
        print(name, "rootFont:", root, "errors:", errors)
        ctx.close()
    browser.close()
