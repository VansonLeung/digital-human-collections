"""HTTP upload adapter for the persistent Qwen ASR engine."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass
import logging
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import wave

from dotenv import dotenv_values
from fastapi import FastAPI, File, Form, HTTPException, UploadFile

from asr_audio import ASREngine

logger = logging.getLogger(__name__)


@dataclass
class Settings:
    model_id: str = "mlx-community/Qwen3-ASR-1.7B-bf16"
    aligner_model_id: str = "mlx-community/Qwen3-ForcedAligner-0.6B-8bit"
    enable_alignment: bool = True
    max_upload_bytes: int = 20 * 1024 * 1024
    max_audio_seconds: float = 60
    decode_timeout_seconds: float = 30
    ffmpeg: str = "ffmpeg"
    host: str = "127.0.0.1"
    port: int = 8001

    def __post_init__(self):
        if min(self.max_upload_bytes, self.max_audio_seconds, self.decode_timeout_seconds) <= 0:
            raise ValueError("ASR upload, duration, and timeout limits must be positive.")
        if not self.model_id or (self.enable_alignment and not self.aligner_model_id):
            raise ValueError("ASR model IDs must not be empty.")

    @classmethod
    def from_env(cls):
        env = {**dotenv_values(Path(__file__).with_name(".env")), **os.environ}
        defaults = cls()
        alignment = env.get("QWEN_ASR_ENABLE_FORCED_ALIGNMENT", "true").lower()
        if alignment not in {"true", "false", "1", "0"}:
            raise ValueError("QWEN_ASR_ENABLE_FORCED_ALIGNMENT must be true or false.")
        return cls(
            model_id=env.get("QWEN_ASR_MODEL_ID", defaults.model_id),
            aligner_model_id=env.get("QWEN_ASR_ALIGNER_MODEL_ID", defaults.aligner_model_id),
            enable_alignment=alignment in {"true", "1"},
            max_upload_bytes=int(env.get("ASR_MAX_UPLOAD_BYTES", defaults.max_upload_bytes)),
            max_audio_seconds=float(env.get("ASR_MAX_AUDIO_SECONDS", defaults.max_audio_seconds)),
            decode_timeout_seconds=float(env.get("ASR_DECODE_TIMEOUT_SECONDS", defaults.decode_timeout_seconds)),
            ffmpeg=env.get("FFMPEG_BIN", defaults.ffmpeg),
            host=env.get("ASR_HOST", defaults.host),
            port=int(env.get("ASR_PORT", defaults.port)),
        )


def normalize_audio(source, target, settings):
    """Bound decoding by time and output duration; disallow network protocols."""
    try:
        subprocess.run(
            [settings.ffmpeg, "-nostdin", "-v", "error", "-y",
             "-protocol_whitelist", "file,pipe", "-i", str(source),
             "-t", str(settings.max_audio_seconds + 1), "-vn", "-ac", "1",
             "-ar", "16000", "-c:a", "pcm_s16le", str(target)],
            check=True, capture_output=True, timeout=settings.decode_timeout_seconds,
        )
        with wave.open(str(target), "rb") as wav:
            duration = wav.getnframes() / wav.getframerate()
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(408, "Audio decoding timed out.") from exc
    except (subprocess.CalledProcessError, wave.Error, EOFError) as exc:
        raise HTTPException(422, "Invalid or unsupported audio recording.") from exc
    if duration <= 0:
        raise HTTPException(422, "The recording contains no audio samples.")
    if duration > settings.max_audio_seconds:
        raise HTTPException(413, "Recording exceeds ASR_MAX_AUDIO_SECONDS.")
    return duration


def create_app(settings=None, engine=None):
    settings = settings or Settings.from_env()
    engine = engine or ASREngine(
        settings.model_id, settings.aligner_model_id if settings.enable_alignment else None,
    )
    gate = asyncio.Lock()

    @asynccontextmanager
    async def lifespan(app):
        if shutil.which(settings.ffmpeg) is None:
            raise RuntimeError("FFmpeg is required. Install it or set FFMPEG_BIN.")
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="asr") as worker:
            app.state.worker = worker
            app.state.ready = False
            await asyncio.get_running_loop().run_in_executor(worker, engine.load)
            app.state.ready = True
            try:
                yield
            finally:
                app.state.ready = False

    app = FastAPI(title="Qwen ASR service", version="0.1.0", lifespan=lifespan)

    @app.get("/health")
    async def health():
        return {"status": "ready" if app.state.ready else "starting",
                "model": settings.model_id, "busy": gate.locked(),
                "forced_alignment": settings.enable_alignment, "languages": engine.languages}

    @app.post("/v1/audio/transcriptions")
    async def transcribe(file: UploadFile = File(...), language: str | None = Form(None),
                         align: bool | None = Form(None)):
        try:
            if gate.locked():
                raise HTTPException(429, "ASR is busy; retry when the current request completes.",
                                    headers={"Retry-After": "1"})
            async with gate:
                with tempfile.TemporaryDirectory(prefix="qwen-asr-") as directory:
                    source = Path(directory) / "upload.audio"
                    target = Path(directory) / "normalized.wav"
                    size = 0
                    with source.open("wb") as output:
                        while chunk := await file.read(1024 * 1024):
                            size += len(chunk)
                            if size > settings.max_upload_bytes:
                                raise HTTPException(413, "Upload exceeds ASR_MAX_UPLOAD_BYTES.")
                            output.write(chunk)
                    if size == 0:
                        raise HTTPException(422, "The uploaded file is empty.")

                    def infer():
                        started = time.perf_counter()
                        duration = normalize_audio(source, target, settings)
                        result = engine.transcribe(
                            target, language, settings.enable_alignment if align is None else align,
                        )
                        return {**result, "duration_seconds": duration,
                                "processing_seconds": time.perf_counter() - started}

                    future = asyncio.get_running_loop().run_in_executor(app.state.worker, infer)
                    try:
                        return await asyncio.shield(future)
                    except asyncio.CancelledError:
                        # Keep the slot and audio alive until Metal work completes.
                        while not future.done():
                            try:
                                await asyncio.shield(future)
                            except asyncio.CancelledError:
                                continue
                            except Exception:
                                break
                        if not future.cancelled():
                            future.exception()  # retrieve discarded worker errors
                        raise
                    except ValueError as exc:
                        raise HTTPException(422, str(exc)) from exc
                    except HTTPException:
                        raise
                    except Exception as exc:
                        logger.exception("ASR inference failed")
                        raise HTTPException(500, "ASR inference failed; inspect service logs.") from exc
        finally:
            await file.close()

    return app


app = create_app()


def main():
    import uvicorn

    settings = Settings.from_env()
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, workers=1)


if __name__ == "__main__":
    main()
