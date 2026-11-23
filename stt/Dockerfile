FROM python:3.12-slim-bookworm
RUN pip install --no-cache-dir faster-whisper==1.2.1 \
    && python -c "from faster_whisper.utils import download_model; download_model('base', output_dir='/opt/whisper')"
WORKDIR /app
COPY service.py .
USER 65534:65534
CMD ["python", "-u", "service.py"]
