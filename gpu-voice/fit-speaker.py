"""Fit a Qwen3-TTS speaker vector from cleaned, mono 24 kHz WAV files."""
import argparse
import os

import numpy as np
import soundfile as sf
import torch
from faster_whisper.vad import get_speech_timestamps
from qwen_tts import Qwen3TTSModel
from scipy.signal import resample_poly
from safetensors.torch import save_file

parser = argparse.ArgumentParser()
parser.add_argument("output")
parser.add_argument("recordings", nargs="+")
args = parser.parse_args()
model = Qwen3TTSModel.from_pretrained(os.environ["QWEN_TTS_MODEL"], device_map="cuda:0",
                                      dtype=torch.bfloat16, attn_implementation="sdpa")
recordings = []
for path in args.recordings:
    audio, rate = sf.read(path, dtype="float32")
    if rate != 24000 or audio.ndim != 1:
        raise ValueError("Expected mono 24 kHz audio")
    regions = get_speech_timestamps(resample_poly(audio, 2, 3), sampling_rate=16000)
    if not regions:
        raise ValueError(f"No speech in {path}")
    speech = np.concatenate([audio[r["start"] * 3 // 2:r["end"] * 3 // 2] for r in regions])
    clips = np.array_split(speech, max(1, round(len(speech) / (6 * rate))))
    with torch.inference_mode():
        vectors = [model.model.extract_speaker_embedding(audio=clip, sr=rate).flatten().float().cpu() for clip in clips]
    recordings.append(torch.stack(vectors))
    print(path, len(clips), "speech windows", flush=True)

# Equal weight per recording. A smooth absolute-distance loss reduces the
# influence of atypical windows without discarding shorter recordings.
initial = torch.stack([r.mean(0) for r in recordings]).mean(0)
speaker = torch.nn.Parameter(initial.clone())
optimizer = torch.optim.Adam([speaker], lr=0.001)
for step in range(150):
    optimizer.zero_grad()
    loss = torch.stack([((r - speaker).square().mean(1) + 1e-7).sqrt().mean() for r in recordings]).mean()
    loss.backward()
    optimizer.step()
norm = torch.stack([r.norm(dim=1).mean() for r in recordings]).mean()
speaker = torch.nn.functional.normalize(speaker.detach(), dim=0) * norm
save_file({"speaker": speaker}, args.output, metadata={"base": "Qwen3-TTS-12Hz-0.6B-Base"})
