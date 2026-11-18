"""Builds the demo video: python edit.py. Voice is cut from the webcam takes by word timings (pauses removed),
visuals are laid under each beat, captions are burned in. Missing real footage shows as a labelled card."""
import array, json, os, subprocess, sys, wave
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
W, H, FPS, RATE = 1920, 1080, 30, 48000
FONT = f"{HERE}/work/SchibstedGrotesk.ttf"
FIX = {"Salon": "Solana", "salon": "Solana", "secret": "Seeker", "seeker": "Seeker", "seeker's": "Seeker's", "thumbprint": "Thumbprint", "thumbprint.": "Thumbprint.",
       "P256": "P-256", "Kokenda": "Kokinda", "his": "its", "precompiled": "precompile", "improve": "approve", "product": "project", "wrote": "write", "product's": "project's"}

# id, voice pieces (take, start, end[, exact words[, gap after]]), visuals
# Visual kinds: ("clip", name, seconds) full-screen animation; ("still", (image, y0, y1, zoom[, x]), seconds) page pan;
# ("cam", None, seconds) rex full screen; ("split", (phone items, panel items), seconds) phone beside a content panel;
# ("panel", (label items, panel items), seconds) the same with a text column instead of the phone.
# Track items: ("v", file, start, seconds[, crop]) video, ("s", image, width, x, y0, y1, seconds) still pan, ("c", clip, seconds).
# ("zoom", card, seconds) slow push in on a real screenshot; ("wide", panel items, seconds) one large panel;
# ("late", clip, None) a clip whose animation starts as the beat ends; ("hold", clip, seconds) its last frame.
V = "voice3"
TOUR, HOME, PAY = ("v", "phone-tour-cfr.mp4"), ("s", "home.png", 1400, 98, 0, 420, None), ("s", "pay.png", 1400, 98, 0, 120, None)
BEATS = [
    ("sec", [(V, 1.6, 7.8)], [("zoom", "card-sec", None)]),
    ("vitalik", [(V, 8.4, 12.1)], [("zoom", "card-vitalik", None)]),
    ("same", [(V, 13.1, 18.2)], [("zoom", "card-both", None)]),
    ("intro", [("cam5", 29.2, 34.9, "I'm Joey Kokinda from Boiler Blockchain, and I built Thumbprint so a hacked account can't steal your followers.")], [("late", "title", None)]),
    ("what", [(V, 21.0, 28.7)], [("hold", "title", 1.2), ("clip", "d-flow", None)]),
    ("setup", [(V, 32.7, 34.12, "Setup happens once."), (V, 34.2, 38.2, "Connect the Seeker's wallet, prove you control the X account, and the phone creates a fingerprint key.")], [("clip", "d-setup", None)]),
    ("owner", [(V, 38.9, 45.8)], [("split", ([("v", "live-post-phone.mp4", 12.5, 5.8), ("v", "live-post-phone.mp4", 167.0, None)], [("c", "p-founder", None)]), None)]),
    ("follower", [(V, 47.7, 56.2)], [("wide", [("v", "live-post-screen.mp4", 209.6, 6.1, "660:440:580:300"), ("v", "live-post-screen.mp4", 216.5, 1.9, "660:440:580:300"), ("v", "live-post-screen.mp4", 227.5, None, "1200:800:360:240")], None)]),
    ("pay", [(V, 60.7, 68.5)], [("clip", "d-pay", None)]),
    ("hacker", [(V, 77.1, 80.2), (V, 83.2, 86.5)], [("split", ([("v", "live-hack-phone.mp4", 6.0, 2.8), ("v", "live-hack-phone.mp4", 21.5, None)], [("v", "live-hack-screen.mp4", 18.0, 4.5, "600:498:600:330"), ("v", "live-hack-screen.mp4", 38.0, None, "600:498:600:330")]), None)]),
    ("reject", [(V, 97.3, 100.74, "I try to send over the payment to my own wallet. Solana rejects it.")], [("clip", "d-reject", None)]),
    ("change", [(V, 100.75, 106.4), (V, 108.2, 110.9)], [("clip", "d-locked", None)]),
    ("kill", [(V, 123.4, 126.05, "And the owner doesn't have to win the account back first.", 0.5), (V, 126.08, 130.1)],
     [("split", ([("v", "live-kill-phone.mp4", 17.8, 2.4), ("v", "live-kill-phone.mp4", 29.6, 2.2), ("v", "live-kill-phone.mp4", 141.0, None)],
                 [("v", "live-kill-screen.mp4", 100.0, 4.6, "600:498:590:500"), ("v", "live-kill-screen.mp4", 155.0, 2.6, "600:498:590:500"), ("v", "live-kill-screen.mp4", 170.0, None, "560:465:420:615")]), None)]),
    ("tech", [(V, 131.3, 133.4), (V, 133.6, 136.7), (V, 136.8, 140.6), (V, 141.2, 143.0)], [("clip", "tech", None)]),
    ("adopt", [(V, 156.7, 161.4)], [("clip", "adopt", None)]),
    ("close", [(V, 162.4, 165.0)], [("clip", "end", None)]),
]
FIX.update({"$700": "$700,000.", ",000.": "", "his": "his", "secured": "secure"})

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
# Pauses carry the room's own background sound: dead silence between sentences is what makes cuts audible.
run("-ss", "75.4", "-t", "1.5", "-i", f"{HERE}/footage/{V}.mp4", "-vn", "-ac", "1", "-ar", str(RATE), "-af", "volume=1.6", f"{HERE}/work/room.wav")
ROOM = array.array("h", wave.open(f"{HERE}/work/room.wav").readframes(10 ** 9))
SLOW = 0.93  # narration tempo; the on-camera take stays at 1 so lips match
def silence(seconds):
    global clock
    n = int(seconds * RATE)
    voice.writeframes(array.array("h", (ROOM[i % len(ROOM)] for i in range(n))).tobytes()); clock += n / RATE
    if camera: camera[-1][2] += int(seconds * RATE) / RATE
def speech(take, start, end):
    """Trims a hand-picked range to where the voice actually starts and stops."""
    clip = wave.open(f"{HERE}/work/{take}.wav"); rate = clip.getframerate(); clip.setpos(int(start * rate))
    samples = array.array("h", clip.readframes(int((end - start) * rate)))
    step = rate // 100
    loud = [max(abs(x) for x in samples[i:i + step]) for i in range(0, len(samples) - step, step)]
    voiced = [i for i, level in enumerate(loud) if level > 0.08 * max(loud)]
    return max(start, start + voiced[0] / 100 - 0.05), min(end, start + (voiced[-1] + 1) / 100 + 0.2)

import numpy
def spectrum(take):
    """Average loudness of the voiced frames in eleven bands."""
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", f"{HERE}/footage/{take}.mp4", "-vn", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-"], capture_output=True, check=True).stdout
    sound = numpy.frombuffer(raw, dtype=numpy.int16).astype(numpy.float32)
    frames = sound[:len(sound) // 4096 * 4096].reshape(-1, 4096)
    frames = frames[frames.std(axis=1) > numpy.median(frames.std(axis=1))]
    power = (numpy.abs(numpy.fft.rfft(frames * numpy.hanning(4096), axis=1)) ** 2).mean(axis=0)
    hertz = numpy.fft.rfftfreq(4096, 1 / RATE)
    return numpy.array([power[(hertz >= middle / 1.26) & (hertz < middle * 1.26)].mean() for middle in BANDS])
BANDS = [100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000]
tones = {}
def tone(take):
    """An equaliser that makes an older take sound like the main recording's microphone."""
    if take == V: return ""
    if take not in tones:
        if V not in tones: tones[V] = spectrum(V)
        gain = 10 * numpy.log10(tones[V] / spectrum(take)); gain = numpy.clip(gain - gain[3:8].mean(), -9, 9)
        tones[take] = "firequalizer=gain_entry='" + ";".join(f"entry({band},{g:.1f})" for band, g in zip(BANDS, gain)) + "',"
        print(take, "tone", " ".join(f"{g:+.0f}" for g in gain))
    return tones[take]

def say(take, a, b, spoken, gap):
    """Appends one stretch of audio; spoken is [(offset from a, offset end, word)]."""
    global clock, count
    path = f"{HERE}/work/n/{count:03d}.wav"; count += 1
    tempo = 1 if take.startswith("cam") else SLOW
    spoken = [(x / tempo, y / tempo, word) for x, y, word in spoken]
    run("-ss", f"{a:.3f}", "-t", f"{b - a:.3f}", "-i", f"{HERE}/footage/{take}.mp4", "-vn", "-ac", "1", "-ar", str(RATE),
        "-af", f"{tone(take)}atempo={tempo},afade=t=in:d=0.04,afade=t=out:st={(b - a) / tempo - 0.12:.3f}:d=0.12", path)
    clip = wave.open(path)
    samples = array.array("h", clip.readframes(clip.getnframes()))
    loud = sorted(abs(x) for x in samples)[int(len(samples) * 0.95)] or 1  # takes come from different mics: match their level
    samples = array.array("h", (max(-32000, min(32000, int(x * 6000 / loud))) for x in samples))
    captions.extend((clock + x, clock + y, FIX.get(word, word)) for x, y, word in spoken if FIX.get(word, word))
    camera.append([take, a, clip.getnframes() / RATE])
    voice.writeframes(samples.tobytes()); clock += clip.getnframes() / RATE
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
            say(take, a, b, spoken, rest[1] if len(rest) > 1 else 0.6)
            continue
        run_words, runs = [], []
        for word in words(take, start, end):
            if run_words and word[0] - run_words[-1][1] > 1.0:
                runs.append(run_words); run_words = []
            run_words.append(word)
        runs.append(run_words)
        for group in runs:
            a, b = group[0][0] - 0.1, min(group[-1][1], group[-1][0] + 0.9) + 0.3
            say(take, a, b, [(w[0] - a, w[1] - a, w[2]) for w in group], 0.85)
    silence(2.6 if name == "close" else 1.2)
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
PAPER, INK = (12, 13, 12), (65, 69, 63)
PHONE, PANEL, LABEL, WIDE = (112, 40, 450, 1000), (660, 40, 1204, 1000), (56, 40, 540, 1000), (210, 40, 1500, 1000)
def mask(width, height, radius, path):
    image = Image.new("L", (width, height), 0)
    ImageDraw.Draw(image).rounded_rectangle((0, 0, width - 1, height - 1), radius, fill=255)
    image.save(path)
def desk(path, phone, box=PANEL):
    image = Image.new("RGB", (W, H), PAPER)
    draw = ImageDraw.Draw(image)
    x, y, w, h = box
    draw.rounded_rectangle((x, y + 8, x + w, y + h + 8), 36, fill=(28, 30, 28))
    if phone:
        x, y, w, h = PHONE
        draw.rounded_rectangle((x - 16, y - 10, x + w + 16, y + h + 22), 62, fill=(28, 30, 28))
        draw.rounded_rectangle((x - 16, y - 16, x + w + 16, y + h + 16), 62, fill=INK)
    image.save(path)
mask(PHONE[2], PHONE[3], 46, f"{HERE}/work/m-phone.png"); mask(PANEL[2], PANEL[3], 36, f"{HERE}/work/m-panel.png")
desk(f"{HERE}/work/desk-phone.png", True); desk(f"{HERE}/work/desk-label.png", False); desk(f"{HERE}/work/desk-wide.png", False, WIDE)
mask(WIDE[2], WIDE[3], 36, f"{HERE}/work/m-wide.png")
from PIL import ImageFont
def card(name, images, tag):
    """A real screenshot on a dark field with a red tag, at 4K so the push in stays sharp."""
    canvas = Image.new("RGB", (3840, 2160), (12, 13, 12))
    shots = [Image.open(f"{HERE}/clips/{i}").convert("RGB") for i in images]
    height = 1500 if len(shots) == 1 else 1300
    shots = [s.resize((round(s.width * height / s.height), height), Image.LANCZOS) for s in shots]
    gap = 120
    x = (3840 - sum(s.width for s in shots) - gap * (len(shots) - 1)) // 2
    top = (2160 - height) // 2 + 90
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.truetype(FONT, 68)
    draw.rounded_rectangle((x, top - 170, x + draw.textlength(tag, font) + 90, top - 50), 16, fill=(255, 90, 60))
    draw.text((x + 45, top - 152), tag, font=font, fill=(12, 13, 12))
    for shot in shots:
        rounded = Image.new("L", shot.size, 0); ImageDraw.Draw(rounded).rounded_rectangle((0, 0, shot.width - 1, shot.height - 1), 44, fill=255)
        canvas.paste(shot, (x, top), rounded); x += shot.width + gap
    canvas.save(f"{HERE}/work/{name}.png")
card("card-sec", ["real-sec.jpg"], "HACKED  ·  JAN 9, 2024")
card("card-vitalik", ["real-vitalik.jpg"], "HACKED  ·  SEP 9, 2023  ·  $691K STOLEN")
card("card-both", ["real-sec.jpg", "real-vitalik.jpg"], "BOTH LOOKED REAL")
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
            argument, skip = argument if isinstance(argument, tuple) else (argument, 0)
            run("-ss", str(skip), "-i", f"{HERE}/clips/{argument}.mp4", "-vf", f"tpad=stop_mode=clone:stop_duration=90,scale={W}:{H}", "-t", t, *BASE, path)
        elif kind == "late":
            run("-i", f"{HERE}/clips/{argument}.mp4", "-vf", f"tpad=start_mode=clone:start_duration={max(0, duration - 0.9):.3f}:stop_mode=clone:stop_duration=90,scale={W}:{H}", "-t", t, *BASE, path)
        elif kind == "hold":
            run("-sseof", "-0.2", "-i", f"{HERE}/clips/{argument}.mp4", "-vf", f"tpad=stop_mode=clone:stop_duration=90,scale={W}:{H}", "-t", t, *BASE, path)
        elif kind == "zoom":
            frames = round((duration + FADE) * FPS)
            run("-i", f"{HERE}/work/{argument}.png", "-vf", f"zoompan=z='1':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s={W}x{H}:fps={FPS}", "-frames:v", str(frames), *BASE, path)
        elif kind == "wide":
            run("-loop", "1", "-i", f"{HERE}/work/desk-wide.png", *track(argument, WIDE[2:], duration + FADE), "-loop", "1", "-i", f"{HERE}/work/m-wide.png", "-filter_complex",
                f"[1:v]format=rgba[p0];[p0][2:v]alphamerge[p];[0:v][p]overlay={WIDE[0]}:{WIDE[1]}", "-t", t, *BASE, path)
        elif kind == "still":
            image, y0, y1, zoom, *anchor = argument
            run("-loop", "1", "-i", f"{HERE}/clips/{image}.png", "-vf", f"scale={int(W * zoom)}:-2,crop={W}:{H}:{anchor[0] if anchor else f'(iw-{W})/2'}:'{y0}+({y1}-{y0})*t/{t}'" + (f",drawbox=x=14:y=356:w=1892:h=92:color=0xff5a3c:t=6,drawbox=x=60:y=60:w=1180:h=110:color=0xff5a3c:t=fill,drawtext=fontfile={FONT}:text='REJECTED BY SOLANA  ·  NOTHING MOVED':fontcolor=0x0c0d0c:fontsize=52:x=96:y=90" if image == "tx-bad" else ""), "-t", t, *BASE, path)
        else:
            side, panel = argument
            box = PHONE if kind == "split" else LABEL
            run("-loop", "1", "-i", f"{HERE}/work/desk-{'phone' if kind == 'split' else 'label'}.png", *track(side, box[2:], duration + FADE), *track(panel, PANEL[2:], duration + FADE),
                "-loop", "1", "-i", f"{HERE}/work/m-phone.png", "-loop", "1", "-i", f"{HERE}/work/m-panel.png", "-filter_complex",
                (f"[1:v]format=rgba[s0];[s0][3:v]alphamerge[s];" if kind == "split" else "[1:v]null[s];") +
                f"[2:v]format=rgba[p0];[p0][4:v]alphamerge[p];[0:v][p]overlay={PANEL[0]}:{PANEL[1]}[b];[b][s]overlay={box[0]}:{box[1]}", "-t", t, *BASE, path)

# ---- Rex full screen for the intro line, then he shrinks into the corner and leaves ----
intro_begin, intro_end = next((b, e) for n, b, e, _ in timing if n == "intro")
cam_length = intro_end - intro_begin + 0.5
run("-ss", f"{first['intro']:.3f}", "-i", f"{HERE}/footage/cam5.mp4", "-vf",
    f"fps={FPS},crop=iw*0.84:ih*0.84:iw*0.08:ih*0.05,scale={W}:{H}:flags=lanczos,eq=brightness=0.1:contrast=1.14:saturation=0.45,unsharp=5:5:0.4,"
    f"drawtext=fontfile={FONT}:text='Joey Kokinda':fontcolor=white:fontsize=76:x=90:y=70:shadowcolor=black@0.6:shadowx=3:shadowy=3,"
    f"drawtext=fontfile={FONT}:text='BOILER BLOCKCHAIN':fontcolor=0x14f195:fontsize=32:x=94:y=164:shadowcolor=black@0.6:shadowx=2:shadowy=2",
    "-t", f"{cam_length:.3f}", *BASE, f"{HERE}/work/v/camfull.mp4")

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
Style: Main,Montserrat,50,&H00FFFFFF,&H00121414,&H00121414,1,1,4,1,2,200,200,34
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
inputs += ["-i", f"{HERE}/work/v/camfull.mp4", "-i", f"{HERE}/work/voice-clean.wav"]
ease = f"(pow(clip((t-{intro_end - 0.8:.3f})/0.7,0,1),2)*(3-2*clip((t-{intro_end - 0.8:.3f})/0.7,0,1)))"
chain.append(f"[{n}:v]format=yuva420p,fade=t=in:st=0:d=0.15:alpha=1,fade=t=out:st={cam_length - 0.3:.3f}:d=0.3:alpha=1,setpts=PTS+{intro_begin:.3f}/TB,"
             f"scale=w='2*trunc(960-710*{ease})':h='2*trunc(540-399*{ease})':eval=frame[cam];"
             f"{previous}[cam]overlay=x='(main_w-overlay_w-64)*{ease}':y='(main_h-overlay_h-64)*{ease}':enable='between(t,{intro_begin:.3f},{intro_begin + cam_length:.3f})':eof_action=pass[o2]")
chain.append(f"[o2]ass={HERE}/work/captions.ass:fontsdir={HERE}/work[v]")
music = f"{HERE}/footage/music.mp3"
if os.path.exists(music):
    inputs += ["-stream_loop", "-1", "-i", music]
    chain.append(f"[{n + 2}:a]volume=0.12,afade=t=in:d=1.5,afade=t=out:st={clock - 3:.2f}:d=3[m0];[{n + 1}:a]asplit[say][key];[m0][key]sidechaincompress=threshold=0.03:ratio=6:attack=40:release=900[m];[say][m]amix=inputs=2:duration=first:normalize=0[a]")
else:
    chain.append(f"[{n + 1}:a]anull[a]")
open(f"{HERE}/work/graph.txt", "w").write(";\n".join(chain))
run(*inputs, "-/filter_complex", f"{HERE}/work/graph.txt", "-map", "[v]", "-map", "[a]", "-t", f"{clock:.2f}", "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", f"{HERE}/out/thumbprint-demo.mp4")
print("wrote out/thumbprint-demo.mp4", f"{clock:.2f}", "music" if os.path.exists(music) else "NO MUSIC")
