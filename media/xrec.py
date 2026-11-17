"""Films X with the Thumbprint extension loaded: uv run --with playwright python xrec.py name url seconds [click-selector]
Logged out, so it only works on public post and profile pages."""
import glob, os, shutil, sys, tempfile
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
EXE = sorted(glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome")))[-1]
name, url, seconds = sys.argv[1], sys.argv[2], float(sys.argv[3])
extension = os.path.abspath(f"{HERE}/../extension")
profile = tempfile.mkdtemp()
with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(profile, executable_path=EXE, headless=False,
        args=[f"--disable-extensions-except={extension}", f"--load-extension={extension}", "--hide-scrollbars"],
        viewport={"width": 1280, "height": 720}, device_scale_factor=1.5, record_video_dir=f"{HERE}/work/xrec", record_video_size={"width": 1920, "height": 1080})
    page = context.new_page()
    page.on("console", lambda m: print("console:", m.type, m.text[:200]) if m.type == "error" and "thumb" in m.text.lower() else None)
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_timeout(seconds * 1000)
    if len(sys.argv) > 4:
        page.click(sys.argv[4]); page.wait_for_timeout(4000)
    print("workers:", [w.url for w in context.service_workers], "article keys:", page.evaluate("[...document.querySelectorAll('article')].map(a => JSON.stringify(a.dataset))"))
    page.screenshot(path=f"{HERE}/clips/{name}.png")
    print(page.evaluate("[...document.querySelectorAll('[class^=\"tp-\"],[class*=\" tp-\"]')].map(e => e.className + ' | ' + e.innerText.slice(0, 120))"))
    video = page.video.path(); context.close()
    shutil.move(video, f"{HERE}/clips/{name}.webm")
