"""Word-timed transcripts of the webcam takes: uv run --with faster-whisper python transcribe.py"""
import json, sys, wave
import numpy as np
from faster_whisper import WhisperModel

model = WhisperModel("medium.en", device="cpu", compute_type="int8")
for name in sys.argv[1:]:
    wav = wave.open(f"work/{name}.wav")
    audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    segments, _ = model.transcribe(audio, word_timestamps=True, vad_filter=True,
        initial_prompt="Thumbprint, Solana Seeker, Boiler Blockchain, Vitalik, the SEC, OpenAI, MicroStrategy, Genesis Token, Seed Vault, P-256 precompile, X account, devnet.")
    out = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip(), "words": [[round(w.start, 2), round(w.end, 2), w.word.strip()] for w in s.words]} for s in segments]
    json.dump(out, open(f"work/{name}.json", "w"))
    print(name, len(out), "segments", flush=True)
