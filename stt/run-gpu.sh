#!/bin/bash
set -eu
cd "$(dirname "$0")"
libs=/home/ai/signflow/.venv/lib/python3.12/site-packages/nvidia
export LD_LIBRARY_PATH="$libs/cublas/lib:$libs/cudnn/lib:$libs/cuda_runtime/lib:${LD_LIBRARY_PATH:-}"
exec ../denys-anime-voice/.qwen-live/bin/python -m uvicorn live:app --host 127.0.0.1 --port 22105 --ws-max-size 8192
