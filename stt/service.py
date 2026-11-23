import io
import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import av
import numpy as np
from faster_whisper import WhisperModel

MAX_BYTES = 2 * 1024 * 1024
SAMPLE_RATE = 16000
MAX_SAMPLES = SAMPLE_RATE * 35
MODEL = WhisperModel("/opt/whisper", device="cpu", compute_type="int8", cpu_threads=4)
MODEL_LOCK = threading.Lock()


def decode(data, container_format):
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    samples = []
    length = 0
    with av.open(io.BytesIO(data), format=container_format) as audio:
        for frame in audio.decode(audio=0):
            for converted in resampler.resample(frame):
                length += converted.samples
                if length > MAX_SAMPLES:
                    raise ValueError("Recording too long")
                samples.append(converted.to_ndarray().ravel())
    if not samples:
        raise ValueError("Empty recording")
    return np.concatenate(samples).astype(np.float32) / 32768


def transcribe_audio(audio):
    segments, _ = MODEL.transcribe(audio, language="en", beam_size=1,
                                   vad_filter=True, condition_on_previous_text=False)
    return " ".join(segment.text.strip() for segment in segments).strip()


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, **payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        url = urlsplit(self.path)
        if url.path != "/transcribe" or url.query != "en":
            return self.reply(404)
        container_format = {"audio/ogg": "ogg", "audio/webm": "matroska",
                            "audio/mp4": "mov"}.get(self.headers.get_content_type())
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if not container_format or not 0 < size <= MAX_BYTES:
            return self.reply(400)
        if not MODEL_LOCK.acquire(blocking=False):
            return self.reply(429)
        try:
            self.connection.settimeout(5)
            audio = decode(self.rfile.read(size), container_format)
            self.reply(200, text=transcribe_audio(audio))
        except (av.error.FFmpegError, IndexError, ValueError, TimeoutError):
            self.reply(400)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            logging.exception("Transcription failed")
            self.reply(500)
        finally:
            MODEL_LOCK.release()


print("Whisper ready on port 8000")
ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
