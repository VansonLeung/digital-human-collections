# Speech services

Independent FastAPI processes for Apple Silicon, using `mlx-audio==0.5.0`.
The chatbot backend should call these APIs; it does not need MLX installed itself.

| Service | Default address | Inference endpoint | Result |
| --- | --- | --- | --- |
| [ASR](asr/README.md) | `http://127.0.0.1:8001` | `POST /v1/audio/transcriptions` | Transcript JSON, optional aligned timestamps |
| [TTS](tts/README.md) | `http://127.0.0.1:8002` | `POST /v1/audio/speech` | Complete PCM16 mono WAV |

Both provide `GET /health`, Swagger UI at `/docs`, and `/openapi.json`.
Models load once during startup on a dedicated inference thread. Each service
admits one inference request at a time; concurrent requests receive HTTP 429
and `Retry-After: 1`. Health requests remain responsive during inference.
Use one Uvicorn worker per service to avoid duplicating model memory.

Each process reads its own `.env`, relative to its source file, with operating
system environment variables taking precedence. Existing `.env` files are
preserved. `PYTHON_BASE` records the interpreter you can use to launch Python;
the running service cannot switch interpreters based on that setting.

Start each process in its own terminal using the instructions below. Defaults
bind to localhost. These are internal POC APIs without authentication or CORS;
the browser should communicate through the chatbot backend. For another trusted
machine to call them, set the service's `*_HOST=0.0.0.0` and use the Mac's LAN IP
in the chatbot's service URL.

Run contract tests from the repository root with a Python environment containing
the service dependencies and `httpx`, and with FFmpeg on PATH:

```bash
~/.common-venv/python3.12/bin/python -m unittest discover -s codes/v1/services/tests -v
```

Tests use fake models and real FFmpeg to check uploads, normalization, alignment
output, WAV metadata, model reuse, input limits, concurrent calls, and failures.
They do not download model weights. Real model quality and latency require
separate listening/transcription checks.
