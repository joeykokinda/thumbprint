"""Asks Gemini to review the cut like a hackathon judge: python review.py [video]. Key comes from ~/.config/helpa/gemini.env."""
import json, os, sys, time, urllib.request

KEY = dict(line.strip().split("=", 1) for line in open(os.path.expanduser("~/.config/helpa/gemini.env")) if "=" in line)["GEMINI_API_KEY"].strip("\"'")
API = "https://generativelanguage.googleapis.com"
HERE = os.path.dirname(os.path.abspath(__file__))
video = sys.argv[1] if len(sys.argv) > 1 else f"{HERE}/out/thumbprint-demo.mp4"

def call(url, data=None, headers={}, method=None):
    request = urllib.request.Request(url, data=data, headers={"x-goog-api-key": KEY, **headers}, method=method)
    with urllib.request.urlopen(request, timeout=600) as response:
        return response.headers, response.read()

models = [m["name"] for m in json.loads(call(f"{API}/v1beta/models?pageSize=200")[1])["models"] if "generateContent" in m.get("supportedGenerationMethods", [])]
pro = sorted(m for m in models if "pro" in m and "gemini" in m and not any(x in m for x in ("tts", "image", "live", "audio")))
model = os.environ.get("MODEL") or pro[-1]
print("model:", model, "| available pro:", pro, flush=True)

size = os.path.getsize(video)
headers, _ = call(f"{API}/upload/v1beta/files", json.dumps({"file": {"display_name": "demo-cut"}}).encode(),
                  {"X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start", "X-Goog-Upload-Header-Content-Length": str(size),
                   "X-Goog-Upload-Header-Content-Type": "video/mp4", "Content-Type": "application/json"})
_, body = call(headers["X-Goog-Upload-URL"], open(video, "rb").read(), {"X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize"})
file = json.loads(body)["file"]
while file["state"] == "PROCESSING":
    time.sleep(5)
    file = json.loads(call(f"{API}/v1beta/{file['name']}")[1])

PROMPT = """You are a judge at a blockchain hackathon (criteria: Technical Execution, Product & UX, Innovation, Impact & Potential, Demo quality).
This is a DRAFT of a team's 2-3 minute demo video. Black cards saying "REAL FOOTAGE GOES HERE" are placeholders for screen recordings not shot yet; do not penalise them, but say what each must show to land.
The narration was cut from webcam takes, so listen for awkward cuts, clipped words, wrong words, and pacing problems.
Be blunt and specific. Give:
1. In two sentences, what you understood the product to be and the problem it solves. (If this is wrong or fuzzy, the video failed.)
2. Score 1-10 for each criterion as the video stands, with one line why.
3. Every moment that is confusing, slow, repetitive, unconvincing or badly cut, with timestamps.
4. Any caption that is wrong or does not match the audio, with timestamps.
5. Does the problem -> solution -> proof logic hold? Where would a skeptical judge push back?
6. What to cut, what to add, what to re-record. Ranked by impact.
7. The single strongest moment and the single weakest."""
body = {"contents": [{"parts": [{"file_data": {"mime_type": "video/mp4", "file_uri": file["uri"]}}, {"text": PROMPT}]}]}
_, out = call(f"{API}/v1beta/{model}:generateContent", json.dumps(body).encode(), {"Content-Type": "application/json"})
text = "".join(part.get("text", "") for part in json.loads(out)["candidates"][0]["content"]["parts"])
open(f"{HERE}/work/review.md", "w").write(text)
print(text)
call(f"{API}/v1beta/{file['name']}", method="DELETE")
