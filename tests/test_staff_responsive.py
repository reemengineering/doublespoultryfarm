from playwright.sync_api import sync_playwright
import time

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    
    # Test portrait 1080x1920
    page = browser.new_page(viewport={'width': 1080, 'height': 1920})
    page.goto('http://localhost:3001/staff/')
    time.sleep(2)
    page.screenshot(path='D:/REMAN Projects/staff_portrait_1080x1920.png')
    print('Portrait 1080x1920 done')
    
    # Test other portrait resolutions
    for w,h in [(720,1280),(768,1366),(1080,2340),(1440,2560)]:
        page.set_viewport_size({'width': w, 'height': h})
        page.reload()
        time.sleep(1)
        page.screenshot(path=f'D:/REMAN Projects/staff_portrait_{w}x{h}.png')
        print(f'Portrait {w}x{h} done')
    
    # Test landscape
    for w,h in [(1920,1080),(2560,1440),(2340,1080)]:
        page.set_viewport_size({'width': w, 'height': h})
        page.reload()
        time.sleep(1)
        page.screenshot(path=f'D:/REMAN Projects/staff_landscape_{w}x{h}.png')
        print(f'Landscape {w}x{h} done')
    
    browser.close()
