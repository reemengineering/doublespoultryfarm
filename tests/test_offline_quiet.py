from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_page(viewport={"width": 1080, "height": 1920})
    page.goto("http://localhost:3001/staff/", wait_until="networkidle")
    page.wait_for_timeout(1500)
    page.keyboard.press("Enter")
    page.wait_for_timeout(400)
    page.keyboard.press("Enter")
    page.wait_for_selector(".terminal", timeout=5000)
    page.wait_for_timeout(1000)
    body = page.evaluate("() => document.querySelector('.terminal').innerText")
    print("mentions scale-not-available:", "Scale not available" in body)
    print("mentions waiting/connect:", "waiting for it to connect" in body.lower())
    hidden = page.evaluate("() => document.getElementById('t-noreading-error').hidden")
    print("trouble line hidden:", hidden)
    page.screenshot(path="D:/REMAN Projects/offline_quiet.png")
    b.close()
