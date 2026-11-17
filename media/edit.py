"""Builds the demo video: python edit.py. Voice is cut from the webcam takes by word timings (pauses removed),
visuals are laid under each beat, captions are burned in. Missing real footage shows as a labelled card."""
import array, json, os, subprocess, sys, wave

HERE = os.path.dirname(os.path.abspath(__file__))
W, H, FPS, RATE = 1920, 1080, 30, 48000
FONT = f"{HERE}/work/SchibstedGrotesk.ttf"
FIX = {"Salon": "Solana", "salon": "Solana", "secret": "Seeker", "seeker": "Seeker", "seeker's": "Seeker's", "thumbprint": "Thumbprint", "thumbprint.": "Thumbprint.",
       "P256": "P-256", "Kokenda": "Kokinda", "his": "its", "precompiled": "precompile", "improve": "approve"}

# id, voice pieces (take, start, end), visuals (kind, argument, seconds or None for "the rest")
BEATS = [
    ("problem", [("cam1", 1.0, 8.1)], [("clip", "hacks", None)]),
    ("play", [("cam1", 8.3, 12.4), ("cam2", 14.4, 18.9)], [("clip", "play", None)]),
    ("password", [("cam2", 33.8, 47.9)], [("clip", "password", None)]),
    ("intro", [("cam2", 68.8, 74.75, "I'm Joey Kokinda from Boiler Blockchain, and I built Thumbprint so that a hacked account cannot steal your followers.")], [("clip", "intro", None)]),
    ("title", [("cam2", 59.15, 60.37, "Thumbprint takes the", 0), ("cam2", 60.33, 65.7)], [("clip", "title", None)]),
    ("pieces", [("cam3", 0.2, 9.7)], [("clip", "pieces", None)]),
    ("founder", [("cam3", 10.2, 20.3)], [("todo", "PHONE: write a post, review screen, fingerprint, it posts", None)]),
    ("follower", [("cam4", 0.1, 7.9), ("cam4", 12.0, 14.55, "Approved posts get a green fingerprint mark."), ("cam4", 14.7, 19.0)], [("todo", "X IN CHROME: green mark on the approved post, click it, proof page", None)]),
    ("pay", [("cam2", 102.2, 107.1)], [("still", ("pay", 0, 420, 1.0), 3.2), ("still", ("tx-ok", 230, 330, 1.3), None)]),
    ("hacked", [("cam2", 113.1, 117.9)], [("clip", "hacked", None)]),
    ("attack1", [("cam2", 127.4, 130.75, "First, I try to send that payment to my own wallet. Solana rejects it."), ("cam2", 133.55, 134.4)], [("clip", "attempt1", 1.9), ("still", ("tx-bad", 6440, 6480, 1.9, 440), None)]),
    ("attack3", [("cam2", 147.5, 149.56, "So I do what every hacker does."), ("cam2", 149.6, 156.7)], [("clip", "attempt3", 3.2), ("todo", "X IN CHROME: post typed straight into X, shows the no-fingerprint warning", None)]),
    ("stop", [("cam3", 200.6, 209.6)], [("todo", "PHONE: tap Suspend, fingerprint, account flagged", 6.2), ("clip", "stop", None)]),
    ("seeker", [("cam3", 31.2, 41.3)], [("phone", "phone-home", None)]),
    ("tech", [("cam3", 103.9, 112.5), ("cam3", 120.8, 122.58, "Android then signs a", 0), ("cam3", 122.5, 131.1), ("cam3", 131.8, 132.86), ("cam3", 133.38, 135.8), ("cam2", 242.7, 248.85)], [("clip", "tech", None)]),
    ("next", [("cam3", 233.85, 239.5), ("cam3", 239.5, 242.5, "Today it's a browser extension and a Seeker app,"), ("cam3", 247.6, 250.5, "and the same check can live inside wallets.")], [("clip", "next", None)]),
    ("close", [("cam2", 277.3, 282.8)], [("clip", "end", None)]),
]

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
clock, captions, timing, count = 0.0, [], [], 0
def silence(seconds):
    global clock
    voice.writeframes(b"\0\0" * int(seconds * RATE)); clock += int(seconds * RATE) / RATE
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
    voice.writeframes(clip.readframes(clip.getnframes())); clock += clip.getnframes() / RATE
    silence(gap)

for name, pieces, visuals in BEATS:
    begin = clock
    if not clock: silence(0.5)
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
    timing.append((name, begin, clock, visuals))
voice.close()
run("-i", f"{HERE}/work/voice.wav", "-af", "highpass=f=85,afftdn=nf=-28,acompressor=threshold=-20dB:ratio=3:attack=5:release=90,loudnorm=I=-15:TP=-1.5", "-ar", str(RATE), f"{HERE}/work/voice-clean.wav")
for name, begin, end, _ in timing:
    said = " ".join(w[2] for w in captions if begin <= w[0] < end)
    print(f"{name:9s} {begin:6.1f} {end - begin:5.1f}s  {said[:90]}")
print(f"total {clock:.1f}s")
json.dump({"timing": [(n, b, e) for n, b, e, _ in timing], "words": captions}, open(f"{HERE}/work/cut.json", "w"))
if "voice" in sys.argv: sys.exit()

# ---- Visuals ----
BASE = ["-r", str(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-pix_fmt", "yuv420p", "-an"]
parts = []
for name, begin, end, visuals in timing:
    left = end - begin
    for index, (kind, argument, seconds) in enumerate(visuals):
        duration = round((seconds if seconds else left) * FPS) / FPS
        left -= duration
        path = f"{HERE}/work/v/{name}-{index}.mp4"; parts.append(path)
        t = f"{duration:.3f}"
        if kind == "clip":
            run("-i", f"{HERE}/clips/{argument}.mp4", "-vf", f"tpad=stop_mode=clone:stop_duration=90,scale={W}:{H}", "-t", t, *BASE, path)
        elif kind == "still":
            image, y0, y1, zoom, *anchor = argument
            run("-loop", "1", "-i", f"{HERE}/clips/{image}.png", "-vf", f"scale={int(W * zoom)}:-2,crop={W}:{H}:{anchor[0] if anchor else f'(iw-{W})/2'}:'{y0}+({y1}-{y0})*t/{t}'", "-t", t, *BASE, path)
        elif kind == "cam":
            take, start = argument
            run("-ss", f"{start:.3f}", "-i", f"{HERE}/footage/{take}.mp4", "-vf", f"crop=iw*0.72:ih*0.72:iw*0.14:ih*0.1,scale={W}:{H}:flags=lanczos,eq=brightness=0.09:contrast=1.12:saturation=0.85,unsharp=5:5:0.6", "-t", t, *BASE, path)
        elif kind == "phone":
            run("-f", "lavfi", "-i", f"color=0xf5f4ef:s={W}x{H}", "-loop", "1", "-i", f"{HERE}/clips/{argument}.png",
                "-filter_complex", f"[1]scale=-2:2500,crop=iw:1000:0:'min(1500,60+130*t)',pad=iw+28:ih+28:14:14:0x141412[p];[0][p]overlay=(W-w)/2:(H-h)/2", "-t", t, *BASE, path)
        else:
            label = argument.replace(":", "\\:").replace("'", "")
            run("-f", "lavfi", "-i", f"color=0x0c0d0c:s={W}x{H}", "-vf",
                f"drawtext=fontfile={FONT}:text='REAL FOOTAGE GOES HERE':fontcolor=0x14f195:fontsize=44:x=(w-tw)/2:y=440,drawtext=fontfile={FONT}:text='{label}':fontcolor=white:fontsize=40:x=(w-tw)/2:y=540", "-t", t, *BASE, path)
open(f"{HERE}/work/v/list.txt", "w").write("".join(f"file '{p}'\n" for p in parts))

# ---- Captions: short phrases, timed to the words ----
def stamp(s): return f"{int(s // 3600)}:{int(s // 60 % 60):02d}:{s % 60:05.2f}"
lines, chunk = [], []
for i, word in enumerate(captions):
    chunk.append(word)
    last = i + 1 == len(captions)
    if last or len(chunk) >= 7 or (len(chunk) >= 3 and word[2][-1] in ".?!,") or captions[i + 1][0] - word[1] > 0.3:
        stop = min(chunk[-1][1] + 0.25, captions[i + 1][0]) if not last else chunk[-1][1] + 0.4
        lines.append(f"Dialogue: 0,{stamp(chunk[0][0])},{stamp(stop)},Main,,0,0,0,,{' '.join(w[2] for w in chunk)}")
        chunk = []
open(f"{HERE}/work/captions.ass", "w").write(f"""[Script Info]
PlayResX: {W}
PlayResY: {H}
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Main,Schibsted Grotesk,50,&H00FFFFFF,&H00121414,&H00121414,1,3,10,0,2,200,200,64
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""" + "\n".join(lines) + "\n")
total = f"{clock:.2f}"
run("-f", "concat", "-safe", "0", "-i", f"{HERE}/work/v/list.txt", "-i", f"{HERE}/work/voice-clean.wav", "-stream_loop", "-1", "-i", f"{HERE}/footage/digital-clouds.mp3",
    "-filter_complex", f"[0:v]ass={HERE}/work/captions.ass:fontsdir={HERE}/work[v];[2:a]volume=0.11,afade=t=out:st={clock - 2.5:.2f}:d=2.5[m];[1:a][m]amix=inputs=2:duration=first:normalize=0[a]",
    "-map", "[v]", "-map", "[a]", "-t", total, "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", f"{HERE}/out/thumbprint-demo.mp4")
print("wrote out/thumbprint-demo.mp4", total)
