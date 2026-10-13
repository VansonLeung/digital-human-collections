"""HTTP WAV adapter for the persistent MLX TTS engine; never plays host audio."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass
import logging
import os
from pathlib import Path
import time

from dotenv import dotenv_values
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

from stream_audio import TTSEngine

logger = logging.getLogger(__name__)


@dataclass
class Settings:
    model_id: str = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit"
    voice: str | None = "Vivian"
    language: str = "auto"
    max_text_chars: int = 2000
    max_audio_seconds: float = 120
    max_tokens: int = 1024
    host: str = "127.0.0.1"
    port: int = 8002

    def __post_init__(self):
        if min(self.max_text_chars, self.max_audio_seconds, self.max_tokens) <= 0:
            raise ValueError("TTS text, audio, and token limits must be positive.")
        if not self.model_id:
            raise ValueError("TTS_MODEL_ID must not be empty.")

    @classmethod
    def from_env(cls):
        env = {**dotenv_values(Path(__file__).with_name(".env")), **os.environ}
        defaults = cls()
        return cls(
            model_id=env.get("TTS_MODEL_ID", defaults.model_id),
            voice=env.get("TTS_VOICE", defaults.voice) or None,
            language=env.get("TTS_LANGUAGE", defaults.language),
            max_text_chars=int(env.get("TTS_MAX_TEXT_CHARS", defaults.max_text_chars)),
            max_audio_seconds=float(env.get("TTS_MAX_AUDIO_SECONDS", defaults.max_audio_seconds)),
            max_tokens=int(env.get("TTS_MAX_TOKENS", defaults.max_tokens)),
            host=env.get("TTS_HOST", defaults.host),
            port=int(env.get("TTS_PORT", defaults.port)),
        )


class SpeechRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=10000)
    voice: str | None = Field(None, max_length=100)
    language: str | None = Field(None, max_length=100)
    instruct: str | None = Field(None, max_length=1000)

    class Config:
        extra = "forbid"


def create_app(settings=None, engine=None):
    settings = settings or Settings.from_env()
    engine = engine or TTSEngine(settings.model_id)
    gate = asyncio.Lock()

    @asynccontextmanager
    async def lifespan(app):
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="tts") as worker:
            app.state.worker = worker
            app.state.ready = False
            await asyncio.get_running_loop().run_in_executor(worker, engine.load)
            app.state.ready = True
            try:
                yield
            finally:
                app.state.ready = False

    app = FastAPI(title="MLX TTS service", version="0.1.0", lifespan=lifespan)

    @app.get("/health")
    async def health():
        return {"status": "ready" if app.state.ready else "starting",
                "model": settings.model_id, "busy": gate.locked(),
                "voices": engine.voices, "languages": engine.languages}

    @app.post("/v1/audio/speech", responses={200: {"content": {"audio/wav": {}}}},
              response_class=Response)
    async def speech(request: SpeechRequest):
        text = request.text.strip()
        if not text or len(text) > settings.max_text_chars:
            raise HTTPException(422, "Text must be nonblank and within TTS_MAX_TEXT_CHARS.")
        if gate.locked():
            raise HTTPException(429, "TTS is busy; retry when the current request completes.",
                                headers={"Retry-After": "1"})
        async with gate:
            def infer():
                return engine.synthesize(
                    text, voice=request.voice or settings.voice,
                    language=request.language or settings.language,
                    instruct=request.instruct, max_tokens=settings.max_tokens,
                    max_audio_seconds=settings.max_audio_seconds,
                )

            started = time.perf_counter()
            future = asyncio.get_running_loop().run_in_executor(app.state.worker, infer)
            try:
                audio, sample_rate, duration = await asyncio.shield(future)
            except asyncio.CancelledError:
                while not future.done():
                    try:
                        await asyncio.shield(future)
                    except asyncio.CancelledError:
                        continue
                    except Exception:
                        break
                if not future.cancelled():
                    future.exception()
                raise
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            except Exception as exc:
                logger.exception("TTS inference failed")
                raise HTTPException(500, "TTS inference failed; inspect service logs.") from exc
            return Response(audio, media_type="audio/wav", headers={
                "Content-Disposition": 'inline; filename="speech.wav"',
                "X-Sample-Rate": str(sample_rate), "X-Audio-Duration": str(duration),
                "X-Processing-Seconds": str(time.perf_counter() - started),
            })

    return app


app = create_app()


def main():
    import uvicorn

    settings = Settings.from_env()
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, workers=1)


if __name__ == "__main__":
    main()
