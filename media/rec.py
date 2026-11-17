"""Records a page as a 1920x1080 clip: uv run --with playwright python rec.py name url seconds [scroll_px]"""
import os, shutil, sys, glob
from playwright.sync_api import sync_playwright

name, url, seconds = sys.argv[1], sys.argv[2], float(sys.argv[3])
scroll = int(sys.argv[4]) if len(sys.argv) > 4 else 0
HERE = os.path.dirname(os.path.abspath(__file__))
EXE = sorted(glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome")))[-1]
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=EXE, args=["--hide-scrollbars"])
    context = browser.new_context(viewport={"width": 1920, "height": 1080}, record_video_dir=f"{HERE}/work/rec", record_video_size={"width": 1920, "height": 1080})
    page = context.new_page()
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_timeout(int(seconds * 1000 * (0.45 if scroll else 1)))
    if scroll:
        steps = 60
        for _ in range(steps):
            page.mouse.wheel(0, scroll / steps)
            page.wait_for_timeout(int(seconds * 1000 * 0.4 / steps))
        page.wait_for_timeout(int(seconds * 1000 * 0.15))
    path = page.video.path()
    context.close(); browser.close()
shutil.move(path, f"{HERE}/clips/{name}.webm")
print(name, "ok")
