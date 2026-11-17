"""Asks Gemini to pick the music bed: python pick.py"""
import json, os, time, urllib.request
KEY = dict(line.strip().split("=", 1) for line in open(os.path.expanduser("~/.config/helpa/gemini.env")) if "=" in line)["GEMINI_API_KEY"].strip("\"'")
API = "https://generativelanguage.googleapis.com"
HERE = os.path.dirname(os.path.abspath(__file__))
NAMES = {"464": "Sci-Fi Score", "140": "Cyberpunk City", "623": "Deep Urban", "609": "Moon Walk", "568": "Focus on Yourself", "134": "Deep Techno Ambience"}
def call(url, data=None, headers={}, method=None):
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers={"x-goog-api-key": KEY, **headers}, method=method), timeout=600) as r:
        return r.headers, r.read()
parts = []
for number, name in NAMES.items():
    path = f"{HERE}/footage/music/{number}.mp3"
    headers, _ = call(f"{API}/upload/v1beta/files", json.dumps({"file": {"display_name": number}}).encode(), {"X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": str(os.path.getsize(path)), "X-Goog-Upload-Header-Content-Type": "audio/mpeg", "Content-Type": "application/json"})
    file = json.loads(call(headers["X-Goog-Upload-URL"], open(path, "rb").read(), {"X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize"})[1])["file"]
    while file["state"] == "PROCESSING":
        time.sleep(3); file = json.loads(call(f"{API}/v1beta/{file['name']}")[1])
    parts += [{"text": f"Track {number}: {name}"}, {"file_data": {"mime_type": "audio/mpeg", "file_uri": file["uri"]}}]
parts.append({"text": """These are candidate music beds for a 2:50 hackathon demo video of a crypto security product (a phone fingerprint that approves a project's posts and payments so a hacked X account cannot scam followers).
Structure: 0:00-0:31 the problem (tense), 0:38 title reveal, 0:45-2:05 product demo and attacks failing (confident, driving), 2:05-2:45 technical explanation, 2:45 closing line.
The music sits quietly under continuous narration, so it needs a steady pulse, no vocals, nothing cheesy or corporate-stock sounding, and it should feel modern and premium.
Rank all six. For the best one give: why, the timestamp of its strongest drop or lift (to land on the title reveal at 0:38), any sections to avoid, and whether it loops cleanly. Be decisive and brief."""})
_, out = call(f"{API}/v1beta/models/gemini-pro-latest:generateContent", json.dumps({"contents": [{"parts": parts}]}).encode(), {"Content-Type": "application/json"})
print("".join(p.get("text", "") for p in json.loads(out)["candidates"][0]["content"]["parts"]))
