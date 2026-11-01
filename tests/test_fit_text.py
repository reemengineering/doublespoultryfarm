# Measure how staff-terminal text scales between 1280x800 and 1920x1080.
from playwright.sync_api import sync_playwright

URL = "http://localhost:3001/staff/"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    results = {}
    for name, w, h in (("1280x800", 1280, 800), ("1920x1080", 1920, 1080)):
        ctx = browser.new_context(viewport={"width": w, "height": h})
        page = ctx.new_page()
        page.goto(URL, wait_until="networkidle")
        page.locator("[data-action='select-formula']").first.click()
        page.wait_for_timeout(400)
        page.locator("[data-action='confirm-batches']").click()
        page.wait_for_timeout(700)
        results[name] = page.evaluate(
            """() => ({
                fit: getComputedStyle(document.documentElement)
                    .getPropertyValue('--screen-fit').trim(),
                rootFont: getComputedStyle(document.documentElement).fontSize,
                formula: getComputedStyle(
                    document.querySelector('.current-formula')).fontSize,
                itemName: getComputedStyle(
                    document.querySelector('.current-item-name')).fontSize,
                lcd: getComputedStyle(
                    document.querySelector('.scale-reading')).fontSize,
                hint: getComputedStyle(
                    document.querySelector('.next-item-hint')).fontSize,
                metricLabel: getComputedStyle(
                    document.querySelector('.scale-caption')).fontSize,
            })"""
        )
        page.screenshot(
            path=f"D:/REMAN Projects/fit_{name}.png",
            full_page=False,
        )
        ctx.close()
    browser.close()

a, b = results["1280x800"], results["1920x1080"]
print("reference :", a)
print("bigger    :", b)
print()
for key in ("formula", "itemName", "lcd", "hint", "metricLabel"):
    def px(v):
        return float(v.replace("px", ""))
    ra, rb = px(a[key]), px(b[key])
    print(f"{key:12s}: {ra:6.1f}px -> {rb:6.1f}px  ({rb / ra:.2f}x)")
