"""Render a reusable reference for an original anime-style adult character."""
import argparse
import os
from pathlib import Path

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

parser = argparse.ArgumentParser()
parser.add_argument("directory", type=Path)
args = parser.parse_args()
args.directory.mkdir(parents=True, exist_ok=True)

transcript = "Hello and welcome. Let us take a closer look at how this laboratory works."
model = Qwen3TTSModel.from_pretrained(
    os.environ.get("VOICE_DESIGN_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"),
    device_map="cuda:0",
    dtype=torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16,
    attn_implementation="sdpa",
)
wavs, rate = model.generate_voice_design(
    text=transcript,
    language="English",
    instruct=(
        "Original anime-inspired adult woman, speaking idiomatic native English. "
        "A bright and warm mid-high register, clear diction, a smile in her voice, "
        "and gentle playful inflection. Natural conversational pace, with restrained "
        "energy and steady volume. No squeaking, whispering, or sound effects."
    ),
)
sf.write(args.directory / "reference.wav", wavs[0], rate)
(args.directory / "reference.txt").write_text(transcript, encoding="utf-8")
