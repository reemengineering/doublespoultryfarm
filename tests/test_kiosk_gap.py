from playwright.sync_api import sync_playwright

# The real kiosk viewport: 32" portrait at Windows 125% DPI scaling.
W, H = 864, 1536

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": W, "height": H})
    page = ctx.new_page()
    page.goto("http://localhost:3001/staff/", wait_until="networkidle")
    page.locator("[data-action='select-formula']").first.click()
    page.wait_for_timeout(400)
    page.locator("[data-action='confirm-batches']").click()
    page.wait_for_timeout(800)
    m = page.evaluate("""() => {
        const cs = s => getComputedStyle(document.documentElement)
            .getPropertyValue(s).trim();
        const rect = el => el ? el.getBoundingClientRect() : null;
        const header = rect(document.querySelector('.app-header')
            || document.querySelector('header'));
        const foot = rect(document.querySelector('.app-footer'));
        const stage = rect(document.querySelector('#screen-main'));
        const almost = rect(document.querySelector('.terminal-layout'));
        const scale = rect(document.querySelector('.scale-panel'));
        const input = rect(document.querySelector('.input-panel'));
        const firstBlock = rect(document.querySelector('.sketch-block'));
        return {
            fit: cs('--screen-fit'), root: cs('font-size'),
            dpr: window.devicePixelRatio,
            headerBottom: header ? header.bottom : null,
            stageTop: stage ? stage.top : null, stageBottom: stage ? stage.bottom : null,
            footTop: foot ? foot.top : null,
            layoutTop: almost ? almost.top : null,
            layoutBottom: almost ? almost.bottom : null,
            scaleTop: scale ? scale.top : null,
            scaleBottom: scale ? scale.bottom : null,
            inputBottom: input ? input.bottom : null,
            gapHeaderToStage: stage && header ? stage.top - header.bottom : null,
            gapStageToFoot: foot && stage ? foot.top - stage.bottom : null,
            cssHeight: window.innerHeight, cssWidth: window.innerWidth,
        };
    }""")
    for k, v in m.items():
        print(f"  {k}: {v}")
    page.screenshot(path="D:/REMAN Projects/kiosk_864x1536.png")
    ctx.close()
    browser.close()
