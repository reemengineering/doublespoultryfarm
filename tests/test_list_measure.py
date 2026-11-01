# Measure the selectable list's available space on the select stage, with a
# long list (rows cloned to 20), at multiple viewport sizes.
from playwright.sync_api import sync_playwright

URL = "http://localhost:3001/staff/"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for name, w, h in (("1280x800", 1280, 800), ("1920x1080", 1920, 1080),
                       ("portrait_720x1280", 720, 1280)):
        ctx = browser.new_context(viewport={"width": w, "height": h})
        page = ctx.new_page()
        page.goto(URL, wait_until="networkidle")
        # Clone formula rows so the list is definitely long.
        page.evaluate("""() => {
            const scroller = document.querySelector('.staff-list-scroll');
            const row = scroller.querySelector('.staff-row');
            for (let i = 0; i < 18; i++) scroller.appendChild(row.cloneNode(true));
        }""")
        data = page.evaluate(
            """() => {
                const list = document.querySelector('.staff-list-scroll');
                const foot = document.querySelector('.app-footer');
                const cs = getComputedStyle(list);
                const root = getComputedStyle(document.documentElement).fontSize;
                const lRect = list.getBoundingClientRect();
                const fRect = foot ? foot.getBoundingClientRect() : null;
                return {
                    rootPx: root,
                    listTop: lRect.top,
                    listBottom: lRect.bottom,
                    scrollH: list.scrollHeight,
                    clientH: list.clientHeight,
                    maxH_style: cs.maxHeight,
                    footTop: fRect ? fRect.top : null,
                    innerH: window.innerHeight,
                    docScrollH: document.documentElement.scrollHeight,
                };
            }"""
        )
        print(name)
        for k, v in data.items():
            print(f"   {k}: {v}")
        # what we COULD give the list: footTop - listTop, and whether list max-h
        # currently exceeds it
        avail = data["footTop"] - data["listTop"]
        print(f"   muchRoomBelowList: {avail:.0f}px   vs maxH {data['maxH_style']}")
        print(f"   overflow: scrollH={data['scrollH']} client={data['clientH']}"
              f" -> inner scrollbar: {data['scrollH'] > data['clientH']}")
        ctx.close()
    browser.close()
