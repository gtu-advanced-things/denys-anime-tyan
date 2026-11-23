"""GPU transcription of 16 kHz mono PCM. The gateway supplies one stream per microphone."""
import asyncio
import os
from pathlib import Path

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from faster_whisper import WhisperModel
from faster_whisper.vad import get_speech_timestamps

root = Path(__file__).parent
model = WhisperModel(str(root / "whisper"), device="cuda", compute_type="int8_float16")
app = FastAPI()
lock = asyncio.Lock()


def decode(pcm):
    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
    if not get_speech_timestamps(audio, sampling_rate=16000):
        return ""
    segments, _ = model.transcribe(audio, language="en", temperature=0, beam_size=2,
                                   condition_on_previous_text=False, without_timestamps=True)
    return " ".join(s.text.strip() for s in segments).strip()


@app.websocket("/live")
async def live(socket: WebSocket):
    language = socket.query_params.get("lang", "en")
    await socket.accept()
    if language != "en":
        return await socket.close(1008)
    buffer = bytearray()
    preview = None
    last_preview = 0

    async def recognize(data, kind):
        async with lock:
            text = await asyncio.to_thread(decode, data)
        await socket.send_json({"type": kind, "text": text})

    try:
        await socket.send_json({"type": "ready"})
        while True:
            event = await socket.receive()
            if event["type"] == "websocket.disconnect":
                break
            data = event.get("bytes")
            if data is not None:
                if len(data) % 2 or len(data) > 8192 or len(buffer) + len(data) > 990000:
                    return await socket.close(1009)
                buffer.extend(data)
                if len(buffer) - last_preview >= 48000 and (preview is None or preview.done()):
                    if preview:
                        preview.result()
                    last_preview = len(buffer)
                    preview = asyncio.create_task(recognize(bytes(buffer), "partial"))
            elif event.get("text") == "end":
                if preview:
                    await preview
                if buffer:
                    await recognize(bytes(buffer), "final")
                buffer.clear()
                preview = None
                last_preview = 0
    except WebSocketDisconnect:
        pass
    finally:
        if preview:
            await asyncio.gather(preview, return_exceptions=True)
