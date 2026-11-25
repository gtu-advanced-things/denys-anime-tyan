"""Stream signed 16-bit little-endian mono PCM from a warmed Qwen3-TTS model."""
import os
import threading
from pathlib import Path

from safetensors.torch import load_file
import torch
from faster_qwen3_tts import FasterQwen3TTS
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

profile = Path(__file__).with_name("amber.safetensors")
speaker = load_file(str(profile))["speaker"].to(device="cuda", dtype=torch.bfloat16)
voice_prompt = {"ref_spk_embedding": [speaker], "x_vector_only_mode": [True]}

torch.set_num_threads(2)
model = FasterQwen3TTS.from_pretrained(
    os.environ["QWEN_TTS_MODEL"], dtype=torch.bfloat16, local_files_only=True,
)
lock = threading.Lock()
app = FastAPI()
sample_rate = 24000


def encode(text):
    for audio, rate, _ in model.generate_voice_clone_streaming(
        text=text, language="English", voice_clone_prompt=voice_prompt,
        chunk_size=4, max_new_tokens=600, temperature=0.7,
    ):
        if rate != sample_rate:
            raise RuntimeError(f"Unexpected sample rate: {rate}")
        yield (audio.clip(-1, 1) * 32767).astype("<i2").tobytes()


# Capture the CUDA graphs and cache the speaker prompt before serving requests.
for _ in encode("Hello. It is good to hear from you."):
    pass


class Speech(BaseModel):
    text: str = Field(min_length=1, max_length=500)


@app.post("/speak")
def speak(request: Speech):
    def stream():
        with lock:
            yield from encode(request.text)

    return StreamingResponse(
        stream(),
        media_type="application/octet-stream",
        headers={"X-Sample-Rate": str(sample_rate), "X-Accel-Buffering": "no"},
    )


@app.get("/health")
def health():
    return {"ready": True, "sample_rate": sample_rate}
