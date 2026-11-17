"""Renders the animated scenes in scenes.html frame by frame (crisp 1920x1080, 30 fps), and full-page stills of live pages.
uv run --with playwright python render.py scenes | stills"""
import glob, os, subprocess, sys
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
EXE = sorted(glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome")))[-1]
FPS = 30
SCENES = [  # name, query, seconds. Delays (d=) are timed to the words in the cut, see edit.py.
    ("hacks", "s=hacks&d=0.1,0.2,3.8,4.4,5.0,5.7", 8.0), ("play", "s=play&d=0.1,0.3,1.5,4.9", 9.0), ("password", "s=password&d=0.1,0.3,7.7,8.6,9.3", 12.0),
    ("title", "s=title&dark=1&d=0,0.25,3.0", 5.0), ("pieces", "s=pieces&d=0.1,0.2,2.8,3.2,5.6,6.0", 8.0), ("hacked", "s=hacked&dark=1&d=0.1,0.2,2.3", 4.0),
    ("tech", "s=tech&dark=1&d=0.1,0.2,8.3,15.8,22.7", 28.0), ("end", "s=end&dark=1", 5.0), ("intro", "s=intro&dark=1&d=0.1,0.2,3.5", 6.0), ("next", "s=next&d=0.1,0.2,5.7,9.3", 12.0),
    ("attempt1", "s=attempt&n=1&t=Pay the hacker's wallet&r=Rejected", 3.0),
    ("attempt3", "s=attempt&n=2&t=Post a fake coin&r=Not approved", 3.2),
    ("stop", "s=attempt&n=3&t=Founder hits suspend&r=Everything stops&ok=1", 3.2),
]
STILLS = [
    ("pay", "https://thumbprint.pyras.org/pay?handle=x:spekthumbprint"), ("demo", "https://thumbprint.pyras.org/demo"),
    ("home", "https://thumbprint.pyras.org/"),
    ("tx-ok", "https://explorer.solana.com/tx/4MoSozd2LwrkbaAw6EWaZSPWhZjfjDogkLJSnt9CzjbBYdWiM3XYjshrPW2YrgooVonN8btLxmFAUiQq98HQe8PW?cluster=devnet"),
    ("tx-bad", "https://explorer.solana.com/tx/xS7pap2ZAaybiMJMB3TL9aYvEpDBJ3y26u8uKCq2HBSaAoqEfrgYL6tr7bMD2chmnpWrZvyebRzjJkXvGk7Wuar?cluster=devnet"),
]
only = sys.argv[2:]
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=EXE, args=["--hide-scrollbars"])
    page = browser.new_context(viewport={"width": 1280, "height": 720}, device_scale_factor=1.5).new_page()
    if sys.argv[1] == "scenes":
        for name, query, seconds in SCENES:
            if only and name not in only: continue
            work = f"{HERE}/work/scene-{name}"
            os.makedirs(work, exist_ok=True)
            page.goto(f"file://{HERE}/scenes.html?{query}")
            page.wait_for_selector(".stage.on")
            page.evaluate("document.getAnimations().forEach(a => a.pause())")
            for frame in range(int(seconds * FPS)):
                page.evaluate("t => document.getAnimations().forEach(a => a.currentTime = t)", frame * 1000 / FPS)
                page.screenshot(path=f"{work}/{frame:04d}.jpg", quality=93, type="jpeg")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(FPS), "-i", f"{work}/%04d.jpg", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", f"{HERE}/clips/{name}.mp4"], check=True)
            print(name, flush=True)
    else:
        for name, url in STILLS:
            if only and name not in only: continue
            page.goto(url, wait_until="networkidle")
            page.wait_for_timeout(2500)
            page.screenshot(path=f"{HERE}/clips/{name}.png", full_page=True)
            print(name, flush=True)
    browser.close()
