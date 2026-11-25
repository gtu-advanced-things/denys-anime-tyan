"""Stream signed 16-bit little-endian mono PCM from a warmed Qwen3-TTS model."""
import asyncio
import os
from concurrent.futures import ThreadPoolExecutor
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
# An aligned speech excerpt supplies acoustic context for pacing and prosody.
reference = profile.with_name("prosody.wav")
reference_text = ""
if reference.exists():
    reference_text = reference.with_suffix(".txt").read_text().strip()
    example = model.model.create_voice_clone_prompt(ref_audio=str(reference), ref_text=reference_text)[0]
    voice_prompt.update(ref_code=[example.ref_code], x_vector_only_mode=[False], icl_mode=[True])
synthesis = ThreadPoolExecutor(max_workers=1, thread_name_prefix="speech-gpu")
app = FastAPI()
sample_rate = 24000


def encode(text):
    for audio, rate, _ in model.generate_voice_clone_streaming(
        text=text, language="Russian", voice_clone_prompt=voice_prompt, ref_text=reference_text,
        chunk_size=4, max_new_tokens=min(900, max(36, len(text) * 2 + 24)), temperature=0.7,
    ):
        if rate != sample_rate:
            raise RuntimeError(f"Unexpected sample rate: {rate}")
        yield (audio.clip(-1, 1) * 32767).astype("<i2").tobytes()


# Capture the CUDA graphs and cache the speaker prompt before serving requests.
def warm_up():
    for _ in encode("Здравствуйте. Рада вас слышать."):
        pass


synthesis.submit(warm_up).result()


class Speech(BaseModel):
    text: str = Field(min_length=1, max_length=500)


@app.post("/speak")
async def speak(request: Speech):
    async def stream():
        loop = asyncio.get_running_loop()
        chunks = asyncio.Queue()
        stopped = threading.Event()

        # The worker owns the entire generator lifetime. A disconnected HTTP
        # reader can never leave a paused generator holding the GPU lock.
        def produce():
            try:
                if stopped.is_set():
                    return
                audio = encode(request.text)
                try:
                    for chunk in audio:
                        if stopped.is_set():
                            break
                        loop.call_soon_threadsafe(chunks.put_nowait, chunk)
                finally:
                    audio.close()
            except Exception as error:
                loop.call_soon_threadsafe(chunks.put_nowait, error)
            finally:
                loop.call_soon_threadsafe(chunks.put_nowait, None)

        job = synthesis.submit(produce)
        try:
            while True:
                chunk = await chunks.get()
                if chunk is None:
                    break
                if isinstance(chunk, Exception):
                    raise chunk
                yield chunk
        finally:
            stopped.set()
            job.cancel()

    return StreamingResponse(
        stream(),
        media_type="application/octet-stream",
        headers={"X-Sample-Rate": str(sample_rate), "X-Accel-Buffering": "no"},
    )


@app.get("/health")
def health():
    return {"ready": True, "sample_rate": sample_rate}
