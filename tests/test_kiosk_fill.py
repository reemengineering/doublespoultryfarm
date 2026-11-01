"""Kiosk 864x1536 (32" portrait at Windows 125% scaling) box-fill proof.

Asserts the auto-fit stage texts FILL their stretched boxes on the real
kiosk viewport: fill ratio high, no vertical overflow, no overlap, no
layout gaps between header/stage/footer.
"""
from playwright.sync_api import sync_playwright

W, H = 864, 1536

MEASURE = """() => {
    const pairs = [
        ['formula',  '.sketch-block:nth-of-type(1)', '.current-formula'],
        ['batchhint','.sketch-block:nth-of-type(1)', '.next-item-hint'],
        ['item',     '.sketch-block:nth-of-type(2)', '.current-item-name'],
        ['nexthint', '.sketch-block:nth-of-type(2)', '.next-item-hint'],
        ['target',   '.sketch-block:nth-of-type(3)', '.sketch-target-value'],
        ['lcd',      '.scale-lcd-box', '.scale-reading'],
        ['cum',      '.scale-cumulative', '.scale-cumulative-value'],
    ];
    const out = { pairs: {} };
    for (const [name, boxSel, elSel] of pairs) {
        const box = document.querySelector(boxSel);
        const el = box ? box.querySelector(elSel) : null;
        if (!box || !el) { out.pairs[name] = null; continue; }
        const fr = el.getBoundingClientRect();
        const br = box.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const lineH = parseFloat(cs.lineHeight) || fr.height;
        const csBox = getComputedStyle(box);
        const innerH = br.height - (parseFloat(csBox.paddingTop) || 0)
            - (parseFloat(csBox.paddingBottom) || 0);
        const fill = fr.height / (innerH || 1);
        out.pairs[name] = {
            fontSize: cs.fontSize,
            fill: +fill.toFixed(3),
            overflowV: +(fr.bottom - br.bottom).toFixed(2),
            overflowH: +(fr.right - br.right).toFixed(2),
            wrapped: lineH > 0 && fr.height > lineH * 1.5,
        };
    }
    // Structural gaps: header->stage->footer must be contiguous.
    const r = s => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
    const header = r('.app-header') || r('header');
    const foot = r('.app-footer');
    const stage = r('#screen-main');
    out.gapHeaderToStage = stage && header ? +(stage.top - header.bottom).toFixed(2) : null;
    out.gapStageToFoot = foot && stage ? +(foot.top - stage.bottom).toFixed(2) : null;
    out.stageBottomVsFoot = foot ? +(stage.bottom - foot.top).toFixed(2) : null;
    out.errors = [];
    return out;
}"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": W, "height": H})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text)
            if m.type == "error" and "404" not in m.text else None)
    page.goto("http://localhost:3001/staff/", wait_until="networkidle")
    page.locator("[data-action='select-formula']").first.click()
    page.wait_for_timeout(400)
    page.locator("[data-action='confirm-batches']").click()
    page.wait_for_timeout(900)  # rAF fit + second pass done

    m = page.evaluate(MEASURE)
    failures = []

    print(f"viewport {W}x{H}")
    for name, d in m["pairs"].items():
        if d is None:
            failures.append(f"{name}: MISSING (box or text not found)")
            continue
        print(
            f"  {name:8s} font={d['fontSize']:>9s} fill={d['fill']:>6.3f} "
            f"ovV={d['overflowV']:>7.2f} ovH={d['overflowH']:>7.2f} wrapped={d['wrapped']}"
        )
        if d["overflowV"] > 1 or d["overflowH"] > 1:
            failures.append(f"{name}: text overflows box (ovV={d['overflowV']}, ovH={d['overflowH']})")
        # Names and hints share the stage font; everything must fill or share
        # its row width, never sit tiny in a corner.
        minimums = {
            "formula": 0.35, "batchhint": 0.08, "item": 0.35,
            "nexthint": 0.08, "target": 0.40, "lcd": 0.55, "cum": 0.55,
        }
        if d["fill"] < minimums[name]:
            failures.append(f"{name}: box too empty, fill={d['fill']}")

    for k in ("gapHeaderToStage", "gapStageToFoot"):
        v = m[k]
        print(f"  {k}: {v}")
        if v is not None and abs(v) > 2:
            failures.append(f"{k}: structural gap of {v}px")

    # Proportional stage sizing: all main texts (ratio 1) share one stage
    # font; the hints sit at exactly HINT_RATIO = 0.5 of it. Both tiers must
    # be internally identical — no stray sizes anywhere on the stage.
    main = {
        k: float(d["fontSize"][:-2])
        for k, d in m["pairs"].items()
        if d and k not in ("batchhint", "nexthint")
    }
    hints = {
        k: float(d["fontSize"][:-2])
        for k, d in m["pairs"].items()
        if d and k in ("batchhint", "nexthint")
    }
    print(f"  stage size: {sorted(set(main.values()))} hints: {sorted(set(hints.values()))}")
    if max(main.values()) - min(main.values()) > 2:
        failures.append(f"main texts not unified: {main}")
    if max(hints.values()) - min(hints.values()) > 2:
        failures.append(f"hints not unified: {hints}")
    stage = sum(main.values()) / len(main)
    for k, v in hints.items():
        if abs(v - stage * 0.5) > 2:
            failures.append(f"{k}: not at 0.5 stage ratio ({v} vs {stage})")

    if errors:
        failures.append(f"JS/console errors: {errors[:5]}")

    page.screenshot(path="D:/REMAN Projects/kiosk_864x1536_filled.png")

    if failures:
        print("FAILURES:")
        for f in failures:
            print(f"  - {f}")
        raise SystemExit(1)
    print("ALL KIOSK-FILL CHECKS PASS")
    ctx.close()
    browser.close()
