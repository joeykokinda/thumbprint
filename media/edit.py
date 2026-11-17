"""Builds the demo video: python edit.py. Voice is cut from the webcam takes by word timings (pauses removed),
visuals are laid under each beat, captions are burned in. Missing real footage shows as a labelled card."""
import array, json, os, subprocess, sys, wave
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
W, H, FPS, RATE = 1920, 1080, 30, 48000
FONT = f"{HERE}/work/SchibstedGrotesk.ttf"
FIX = {"Salon": "Solana", "salon": "Solana", "secret": "Seeker", "seeker": "Seeker", "seeker's": "Seeker's", "thumbprint": "Thumbprint", "thumbprint.": "Thumbprint.",
       "P256": "P-256", "Kokenda": "Kokinda", "his": "its", "precompiled": "precompile", "improve": "approve"}

# id, voice pieces (take, start, end[, exact words[, gap after]]), visuals
# Visual kinds: ("clip", name, seconds) full-screen animation; ("still", (image, y0, y1, zoom[, x]), seconds) page pan;
# ("cam", None, seconds) rex full screen; ("split", (phone items, panel items), seconds) phone beside a content panel;
# ("panel", (label items, panel items), seconds) the same with a text column instead of the phone.
# Track items: ("v", file, start, seconds[, crop]) video, ("s", image, width, x, y0, y1, seconds) still pan, ("c", clip, seconds).
FEED = lambda y0, y1, seconds: ("s", "x-feed.jpg", 1400, 185, y0, y1, seconds)
BEATS = [
    ("problem", [("cam1", 1.0, 8.1)], [("clip", "hacks", None)]),
    ("play", [("cam1", 8.3, 12.4), ("cam2", 14.4, 18.9)], [("clip", "play", None)]),
    ("password", [("cam2", 33.8, 47.9)], [("clip", "password", None)]),
    ("intro", [("cam2", 68.8, 74.75, "I'm Joey Kokinda from Boiler Blockchain, and I built Thumbprint so that a hacked account cannot steal your followers.")], [("cam", None, None)]),
    ("title", [("cam2", 59.15, 60.37, "Thumbprint takes the", 0), ("cam2", 60.33, 65.7)], [("clip", "title", None)]),
    ("pieces", [("cam3", 0.2, 9.7)], [("clip", "pieces", None)]),
    ("app", [("cam4", 112.6, 119.95)], [("split", ([("v", "phone-kill-cfr.mp4", 2.0, None)], [("c", "p-app", None)]), None)]),
    ("founder", [("cam3", 10.2, 20.3)], [("split", ([("v", "phone-post-cfr.mp4", 9.0, 3.9), ("v", "phone-post-cfr.mp4", 19.0, 2.7), ("v", "phone-post-cfr.mp4", 82.5, None)], [("c", "p-founder", None)]), None)]),
    ("follower", [("cam4", 0.1, 7.9), ("cam4", 12.0, 14.55, "Approved posts get a green fingerprint mark."), ("cam4", 14.7, 19.0)],
     [("panel", ([("c", "l-follower", None)], [FEED(70, 300, 10.4), ("s", "x-popup.jpg", 1400, 185, 300, 300, 2.2), ("v", "chrome-approved.mp4", 21.0, None, "1030:855:440:215")]), None)]),
    ("pay", [("cam2", 102.2, 107.1)], [("still", ("pay", 0, 420, 1.0), 3.2), ("still", ("tx-ok", 230, 330, 1.3), None)]),
    ("hacked", [("cam2", 113.1, 117.9)], [("clip", "hacked", None)]),
    ("attack1", [("cam2", 127.4, 130.75, "First, I try to send that payment to my own wallet. Solana rejects it."), ("cam2", 133.55, 134.4)], [("clip", "attempt1", 1.9), ("still", ("tx-bad", 6440, 6480, 1.9, 440), None)]),
    ("attack3", [("cam2", 147.5, 149.56, "So I do what every hacker does."), ("cam2", 149.6, 156.7)],
     [("clip", "attempt3", 2.3), ("split", ([("v", "phone-hack-cfr.mp4", 54.0, None)], [("s", "x-feed.jpg", 1500, 215, 40, 70, None)]), None)]),
    ("stop", [("cam3", 200.6, 209.6)], [("split", ([("v", "phone-kill-cfr.mp4", 11.8, 2.7), ("v", "phone-kill-cfr.mp4", 19.0, 1.4), ("v", "phone-kill-cfr.mp4", 30.5, 1.2), ("v", "phone-kill-cfr.mp4", 37.0, None)],
                                                    [("c", "p-stop", 6.9), ("s", "tx-stop.png", 3648, 440, 6230, 6270, None)]), None)]),
    ("seeker", [("cam3", 31.2, 41.3)], [("split", ([("v", "phone-post-cfr.mp4", 9.0, 9.5), ("v", "phone-kill-cfr.mp4", 0.0, None)], [("c", "p-seeker", None)]), None)]),
    ("tech", [("cam3", 103.9, 112.5), ("cam3", 120.8, 122.58, "Android then signs a", 0), ("cam3", 122.5, 131.1), ("cam3", 131.8, 132.86), ("cam3", 133.38, 135.8), ("cam2", 242.7, 248.85)], [("clip", "tech", None)]),
    ("close", [("cam2", 277.3, 282.8)], [("clip", "end", None)]),
]
NO_PIP = ("intro", "close")

def run(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)

def words(take, start, end):
    found = [w for s in json.load(open(f"{HERE}/work/{take}.json")) for w in s["words"]]
    if take == "cam2":  # the first pass skipped the intro; it was transcribed separately
        found = sorted([w for w in found if not 48 < w[0] < 74.5] + [w for w in json.load(open(f"{HERE}/work/gap.json")) if w[0] < 74.5])
    return [w for w in found if start <= w[0] < end]

os.makedirs(f"{HERE}/work/n", exist_ok=True)
os.makedirs(f"{HERE}/work/v", exist_ok=True)
voice = wave.open(f"{HERE}/work/voice.wav", "wb")
voice.setnchannels(1); voice.setsampwidth(2); voice.setframerate(RATE)
clock, captions, timing, count, camera, first = 0.0, [], [], 0, [], {}
def silence(seconds):
    global clock
    voice.writeframes(b"\0\0" * int(seconds * RATE)); clock += int(seconds * RATE) / RATE
    if camera: camera[-1][2] += int(seconds * RATE) / RATE
def speech(take, start, end):
    """Trims a hand-picked range to where the voice actually starts and stops."""
    clip = wave.open(f"{HERE}/work/{take}.wav"); rate = clip.getframerate(); clip.setpos(int(start * rate))
    samples = array.array("h", clip.readframes(int((end - start) * rate)))
    step = rate // 100
    loud = [max(abs(x) for x in samples[i:i + step]) for i in range(0, len(samples) - step, step)]
    voiced = [i for i, level in enumerate(loud) if level > 0.08 * max(loud)]
    return max(start, start + voiced[0] / 100 - 0.05), min(end, start + (voiced[-1] + 1) / 100 + 0.2)

def say(take, a, b, spoken, gap):
    """Appends one stretch of audio; spoken is [(offset from a, offset end, word)]."""
    global clock, count
    path = f"{HERE}/work/n/{count:03d}.wav"; count += 1
    run("-ss", f"{a:.3f}", "-t", f"{b - a:.3f}", "-i", f"{HERE}/footage/{take}.mp4", "-vn", "-ac", "1", "-ar", str(RATE),
        "-af", f"afade=t=in:d=0.02,afade=t=out:st={b - a - 0.03:.3f}:d=0.03", path)
    clip = wave.open(path)
    captions.extend((clock + x, clock + y, FIX.get(word, word)) for x, y, word in spoken)
    camera.append([take, a, clip.getnframes() / RATE])
    voice.writeframes(clip.readframes(clip.getnframes())); clock += clip.getnframes() / RATE
    silence(gap)

for name, pieces, visuals in BEATS:
    begin = clock
    if not clock: silence(0.5)
    mark = len(camera)
    for take, start, end, *rest in pieces:
        if rest:  # hand-picked range with its own words: the transcript was wrong here (restarts, stammers)
            a, b = speech(take, start, end)
            text = rest[0].split(); total = sum(len(w) + 1 for w in text); at = 0
            spoken = []
            for word in text:
                spoken.append(((b - a) * at / total, (b - a) * (at + len(word) + 1) / total, word)); at += len(word) + 1
            say(take, a, b, spoken, rest[1] if len(rest) > 1 else 0.1)
            continue
        run_words, runs = [], []
        for word in words(take, start, end):
            if run_words and word[0] - run_words[-1][1] > 0.38 and visuals[0][0] != "cam":
                runs.append(run_words); run_words = []
            run_words.append(word)
        runs.append(run_words)
        for group in runs:
            a, b = group[0][0] - 0.06, min(group[-1][1], group[-1][0] + 0.9) + 0.14
            say(take, a, b, [(w[0] - a, w[1] - a, w[2]) for w in group], 0.1)
    silence(0.4)
    first[name] = camera[mark][1]
    timing.append((name, begin, clock, visuals))
voice.close()
run("-i", f"{HERE}/work/voice.wav", "-af", "highpass=f=85,afftdn=nf=-28,acompressor=threshold=-20dB:ratio=3:attack=5:release=90,loudnorm=I=-15:TP=-1.5", "-ar", str(RATE), f"{HERE}/work/voice-clean.wav")
for name, begin, end, _ in timing:
    said = " ".join(w[2] for w in captions if begin <= w[0] < end)
    print(f"{name:9s} {begin:6.1f} {end - begin:5.1f}s  {said[:90]}")
print(f"total {clock:.1f}s")
json.dump({"timing": [(n, b, e) for n, b, e, _ in timing], "words": captions}, open(f"{HERE}/work/cut.json", "w"))
if "voice" in sys.argv: sys.exit()

# ---- Frames and masks ----
PAPER, INK = (245, 244, 239), (20, 20, 18)
PHONE, PANEL, LABEL = (112, 40, 450, 1000), (660, 40, 1204, 1000), (56, 40, 540, 1000)
PIP = (1664, 824, 216)
def mask(width, height, radius, path):
    image = Image.new("L", (width, height), 0)
    ImageDraw.Draw(image).rounded_rectangle((0, 0, width - 1, height - 1), radius, fill=255)
    image.save(path)
def desk(path, phone):
    image = Image.new("RGB", (W, H), PAPER)
    draw = ImageDraw.Draw(image)
    x, y, w, h = PANEL
    draw.rounded_rectangle((x, y + 8, x + w, y + h + 8), 36, fill=(226, 225, 218))
    if phone:
        x, y, w, h = PHONE
        draw.rounded_rectangle((x - 16, y - 10, x + w + 16, y + h + 22), 62, fill=(214, 212, 202))
        draw.rounded_rectangle((x - 16, y - 16, x + w + 16, y + h + 16), 62, fill=INK)
    image.save(path)
mask(PHONE[2], PHONE[3], 46, f"{HERE}/work/m-phone.png"); mask(PANEL[2], PANEL[3], 36, f"{HERE}/work/m-panel.png"); mask(PIP[2], PIP[2], PIP[2] // 2, f"{HERE}/work/m-pip.png")
desk(f"{HERE}/work/desk-phone.png", True); desk(f"{HERE}/work/desk-label.png", False)
ring = Image.new("RGBA", (PIP[2] + 16, PIP[2] + 16), (0, 0, 0, 0))
ImageDraw.Draw(ring).ellipse((3, 3, PIP[2] + 12, PIP[2] + 12), outline=(245, 244, 239, 255), width=6)
ring.save(f"{HERE}/work/ring.png")

BASE = ["-r", str(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-an"]
FADE = 0.2
serial = 0
def track(items, size, total):
    """A sequence of videos, stills and clips cut to one size; the last item fills what is left."""
    global serial
    width, height = size
    files, left = [], total
    for kind, *args in items:
        seconds = args[-2] if kind == "v" and len(args) == 4 else args[-1]
        crop = args[-1] if kind == "v" and len(args) == 4 else None
        duration = left if seconds is None else min(seconds, left)
        left -= duration
        if duration <= 0.02: continue
        path = f"{HERE}/work/v/t{serial:03d}.mp4"; serial += 1; files.append(path)
        fit = f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,crop={width}:{height},setsar=1"
        if kind == "v":
            run("-ss", f"{args[1]:.2f}", "-i", f"{HERE}/footage/{args[0]}", "-vf", (f"crop={crop}," if crop else "") + f"tpad=stop_mode=clone:stop_duration=30,{fit}", "-t", f"{duration:.3f}", *BASE, path)
        elif kind == "c":
            run("-i", f"{HERE}/clips/{args[0]}.mp4", "-vf", f"tpad=stop_mode=clone:stop_duration=90,{fit}", "-t", f"{duration:.3f}", *BASE, path)
        else:
            image, wide, x, y0, y1 = args[:5]
            run("-loop", "1", "-i", f"{HERE}/clips/{image}", "-vf", f"scale={wide}:-2:flags=lanczos,crop={width}:{height}:{x}:'{y0}+({y1}-{y0})*t/{duration:.3f}',setsar=1", "-t", f"{duration:.3f}", *BASE, path)
    listing = f"{HERE}/work/v/t{serial:03d}.txt"; serial += 1
    open(listing, "w").write("".join(f"file '{p}'\n" for p in files))
    return ["-f", "concat", "-safe", "0", "-i", listing]

parts, starts = [], []
for name, begin, end, visuals in timing:
    left, at = end - begin, begin
    for index, (kind, argument, seconds) in enumerate(visuals):
        duration = seconds if seconds else left
        left -= duration
        path = f"{HERE}/work/v/{name}-{index}.mp4"; parts.append(path); starts.append(at); at += duration
        t = f"{duration + FADE:.3f}"  # each part runs a little long so the next can fade in over it
        if kind == "clip":
            run("-i", f"{HERE}/clips/{argument}.mp4", "-vf", f"tpad=stop_mode=clone:stop_duration=90,scale={W}:{H}", "-t", t, *BASE, path)
        elif kind == "still":
            image, y0, y1, zoom, *anchor = argument
            run("-loop", "1", "-i", f"{HERE}/clips/{image}.png", "-vf", f"scale={int(W * zoom)}:-2,crop={W}:{H}:{anchor[0] if anchor else f'(iw-{W})/2'}:'{y0}+({y1}-{y0})*t/{t}'", "-t", t, *BASE, path)
        elif kind == "cam":
            take = next(p[0] for n, p, _ in BEATS if n == name)[0]
            run("-ss", f"{first[name]:.3f}", "-i", f"{HERE}/footage/{take}.mp4", "-vf",
                f"crop=iw*0.78:ih*0.78:iw*0.11:ih*0.06,scale={W}:{H}:flags=lanczos,eq=brightness=0.08:contrast=1.1:saturation=0.9,unsharp=5:5:0.5,"
                f"drawbox=x=0:y=820:w=iw:h=260:color=0x141412@0.55:t=fill,drawtext=fontfile={FONT}:text='JOEY KOKINDA':fontcolor=white:fontsize=74:x=110:y=850,"
                f"drawtext=fontfile={FONT}:text='Boiler Blockchain  ·  Thumbprint':fontcolor=0x14f195:fontsize=38:x=112:y=940", "-t", t, *BASE, path)
        else:
            side, panel = argument
            box = PHONE if kind == "split" else LABEL
            run("-loop", "1", "-i", f"{HERE}/work/desk-{'phone' if kind == 'split' else 'label'}.png", *track(side, box[2:], duration + FADE), *track(panel, PANEL[2:], duration + FADE),
                "-loop", "1", "-i", f"{HERE}/work/m-phone.png", "-loop", "1", "-i", f"{HERE}/work/m-panel.png", "-filter_complex",
                (f"[1:v]format=rgba[s0];[s0][3:v]alphamerge[s];" if kind == "split" else "[1:v]null[s];") +
                f"[2:v]format=rgba[p0];[p0][4:v]alphamerge[p];[0:v][p]overlay={PANEL[0]}:{PANEL[1]}[b];[b][s]overlay={box[0]}:{box[1]}", "-t", t, *BASE, path)

# ---- Rex in the corner, cut exactly like the voice ----
frames_done, files = 0, []
for index, (take, start, seconds) in enumerate(camera):
    if index == 0: start, seconds = start - 0.5, seconds  # the half second of quiet before the first word is already in seconds
    upto = round((sum(c[2] for c in camera[:index + 1])) * FPS)
    count_frames, frames_done = upto - frames_done, upto
    if count_frames <= 0: continue
    path = f"{HERE}/work/v/cam{index:03d}.mp4"; files.append(path)
    run("-ss", f"{start:.3f}", "-i", f"{HERE}/footage/{take}.mp4", "-vf", f"fps={FPS},crop=560:560:360:60,scale={PIP[2]}:{PIP[2]}:flags=lanczos,eq=brightness=0.08:contrast=1.1:saturation=0.9",
        "-frames:v", str(count_frames), *BASE, path)
open(f"{HERE}/work/v/cam.txt", "w").write("".join(f"file '{p}'\n" for p in files))

# ---- Captions: a few big words at a time, the spoken one in green ----
def stamp(s): return f"{int(s // 3600)}:{int(s // 60 % 60):02d}:{s % 60:05.2f}"
lines, chunk = [], []
for i, word in enumerate(captions):
    chunk.append(word)
    last = i + 1 == len(captions)
    if last or len(chunk) == 3 or word[2][-1] in ".?!," or captions[i + 1][0] - word[1] > 0.3:
        stop = chunk[-1][1] + 0.3 if last else min(chunk[-1][1] + 0.3, captions[i + 1][0])
        for active, spoken in enumerate(chunk):
            until = chunk[active + 1][0] if active + 1 < len(chunk) else stop
            text = "  ".join(("{\\c&H95F114&}" if n == active else "{\\c&HFFFFFF&}") + w[2].upper() for n, w in enumerate(chunk))
            lines.append(f"Dialogue: 0,{stamp(spoken[0] if active else chunk[0][0])},{stamp(until)},Main,,0,0,0,,{text}")
        chunk = []
open(f"{HERE}/work/captions.ass", "w").write(f"""[Script Info]
PlayResX: {W}
PlayResY: {H}
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Main,Montserrat,62,&H00FFFFFF,&H00121414,&H00121414,1,1,4,1,2,200,200,56
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""" + "\n".join(lines) + "\n")

# ---- Assemble: quick fades between shots, corner camera, captions, music ----
inputs, chain = [], []
for path in parts: inputs += ["-i", path]
previous = "[0:v]"
for index in range(1, len(parts)):
    chain.append(f"{previous}[{index}:v]xfade=transition=fade:duration={FADE}:offset={starts[index]:.3f}[x{index}]"); previous = f"[x{index}]"
n = len(parts)
inputs += ["-f", "concat", "-safe", "0", "-i", f"{HERE}/work/v/cam.txt", "-loop", "1", "-i", f"{HERE}/work/m-pip.png", "-loop", "1", "-i", f"{HERE}/work/ring.png", "-i", f"{HERE}/work/voice-clean.wav"]
hide = "+".join(f"between(t,{b - 0.1:.2f},{e:.2f})" for name, b, e, _ in timing if name in NO_PIP)
chain.append(f"[{n}:v]format=rgba[c0];[c0][{n + 1}:v]alphamerge[c1];{previous}[c1]overlay={PIP[0]}:{PIP[1]}:enable='not({hide})'[o1];[o1][{n + 2}:v]overlay={PIP[0] - 8}:{PIP[1] - 8}:enable='not({hide})'[o2]")
chain.append(f"[o2]ass={HERE}/work/captions.ass:fontsdir={HERE}/work[v]")
music = f"{HERE}/footage/music.mp3"
if os.path.exists(music):
    inputs += ["-stream_loop", "-1", "-i", music]
    chain.append(f"[{n + 4}:a]volume=0.2,afade=t=in:d=1.5,afade=t=out:st={clock - 3:.2f}:d=3[m0];[{n + 3}:a]asplit[say][key];[m0][key]sidechaincompress=threshold=0.03:ratio=6:attack=40:release=900[m];[say][m]amix=inputs=2:duration=first:normalize=0[a]")
else:
    chain.append(f"[{n + 3}:a]anull[a]")
open(f"{HERE}/work/graph.txt", "w").write(";\n".join(chain))
run(*inputs, "-/filter_complex", f"{HERE}/work/graph.txt", "-map", "[v]", "-map", "[a]", "-t", f"{clock:.2f}", "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", f"{HERE}/out/thumbprint-demo.mp4")
print("wrote out/thumbprint-demo.mp4", f"{clock:.2f}", "music" if os.path.exists(music) else "NO MUSIC")
