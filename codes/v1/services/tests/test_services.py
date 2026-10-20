"""Contract tests with fake models and real FFmpeg; no model downloads needed."""

from concurrent.futures import ThreadPoolExecutor
import asyncio
import io
from pathlib import Path
import sys
import threading
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave

import numpy as np
import httpx
from fastapi.testclient import TestClient

SERVICES = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(SERVICES / "asr"), str(SERVICES / "tts")]
from asr_api import Settings as ASRSettings, create_app as asr_app
from asr_audio import ASREngine
from stream_audio import TTSEngine
from tts_api import Settings as TTSSettings, create_app as tts_app
from emotions import EMOTION_INSTRUCTIONS


def wav_bytes(seconds=0.1, rate=16000):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(b"\0\0" * int(seconds * rate))
    return output.getvalue()


class FakeASR:
    languages = ["english", "chinese", "cantonese"]

    def __init__(self):
        self.loads = 0
        self.paths = []
        self.entered = threading.Event()
        self.release = threading.Event()
        self.block = False

    def load(self):
        self.loads += 1
        self.worker_thread = threading.get_ident()

    def transcribe(self, path, language, align):
        assert self.worker_thread == threading.get_ident()
        self.paths.append(Path(path))
        if self.block:
            self.entered.set()
            assert self.release.wait(5)
        with wave.open(str(path), "rb") as wav:
            assert wav.getframerate() == 16000
            assert wav.getnchannels() == 1
        return {"text": "Hello", "language": "English", "segments": [],
                "words": [], "alignment_performed": align}


class FakeTTS:
    voices = ["Vivian"]
    languages = ["auto", "english"]

    def __init__(self):
        self.loads = 0
        self.entered = threading.Event()
        self.release = threading.Event()
        self.block = False

    def load(self):
        self.loads += 1
        self.worker_thread = threading.get_ident()

    def synthesize(self, text, **kwargs):
        assert self.worker_thread == threading.get_ident()
        self.kwargs = kwargs
        if self.block:
            self.entered.set()
            assert self.release.wait(5)
        return wav_bytes(rate=48000), 48000, 0.1


class ASRAPITests(unittest.TestCase):
    def test_upload_normalization_cleanup_and_model_reuse(self):
        engine = FakeASR()
        with TestClient(asr_app(ASRSettings(), engine)) as client:
            self.assertEqual(client.get("/health").json()["status"], "ready")
            for _ in range(2):
                response = client.post("/v1/audio/transcriptions",
                                       files={"file": ("voice.wav", wav_bytes(rate=48000))},
                                       data={"language": "en", "align": "false"})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertFalse(response.json()["alignment_performed"])
                self.assertAlmostEqual(response.json()["duration_seconds"], 0.1)
        self.assertEqual(engine.loads, 1)
        self.assertTrue(all(not path.exists() for path in engine.paths))

    def test_empty_corrupt_and_oversized_upload(self):
        with TestClient(asr_app(ASRSettings(max_upload_bytes=4000), FakeASR())) as client:
            for audio, status in [(b"", 422), (b"bad audio", 422), (b"x" * 4001, 413)]:
                with self.subTest(status=status, size=len(audio)):
                    result = client.post("/v1/audio/transcriptions", files={"file": ("audio", audio)})
                    self.assertEqual(result.status_code, status)

    def test_duration_limit(self):
        with TestClient(asr_app(ASRSettings(max_audio_seconds=0.05), FakeASR())) as client:
            response = client.post("/v1/audio/transcriptions", files={"file": ("audio", wav_bytes())})
            self.assertEqual(response.status_code, 413)

    def test_missing_ffmpeg_fails_startup(self):
        with self.assertRaisesRegex(RuntimeError, "FFmpeg"):
            with TestClient(asr_app(ASRSettings(ffmpeg="/missing/ffmpeg"), FakeASR())):
                pass

    def test_qwen_language_list_and_forced_alignment(self):
        engine = ASREngine("fake")
        engine.model = SimpleNamespace(
            get_supported_languages=lambda: ["english"],
            generate=lambda **kwargs: SimpleNamespace(text=" Hello ", language=["English"], segments=[]),
        )
        calls = []
        engine.aligner = SimpleNamespace(generate=lambda **kwargs: (
            calls.append(kwargs) or [SimpleNamespace(text="Hello", start_time=0.02, end_time=0.2)]
        ))
        result = engine.transcribe("input.wav", "en", align=True)
        self.assertEqual(result["language"], "English")
        self.assertEqual(result["words"][0]["start"], 0.02)
        self.assertEqual(calls[0]["language"], "English")
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            engine.transcribe("input.wav", "unknown")
        engine.aligner = None
        with self.assertRaisesRegex(ValueError, "disabled"):
            engine.transcribe("input.wav", align=True)

    def test_installed_qwen_capabilities_from_config(self):
        engine = ASREngine("fake")
        engine.model = SimpleNamespace(config=SimpleNamespace(support_languages=["English", "Cantonese"]))
        self.assertEqual(engine.languages, ["English", "Cantonese"])


class TTSAPITests(unittest.TestCase):
    def test_reference_profiles_share_model_and_missing_male_profile_is_explicit(self):
        engine = FakeTTS()
        with tempfile.TemporaryDirectory() as directory:
            female = Path(directory) / "female.wav"
            male = Path(directory) / "male.wav"
            female.write_bytes(wav_bytes())
            male.write_bytes(wav_bytes())
            settings = TTSSettings(ref_audio=str(female), ref_text="Female reference",
                                   user_male_ref_audio=str(male), user_male_ref_text="Male reference")
            with TestClient(tts_app(settings, engine)) as client:
                self.assertTrue(client.get("/health").json()["voice_profiles"]["user_male"]["configured"])
                self.assertEqual(client.post("/v1/audio/speech", json={"text": "First", "profile": "user_male"}).status_code, 200)
                self.assertEqual(engine.kwargs["ref_audio"], str(male))
                self.assertEqual(engine.kwargs["ref_text"], "Male reference")
                self.assertIsNone(engine.kwargs["voice"])
                self.assertEqual(client.post("/v1/audio/speech", json={"text": "Second"}).status_code, 200)
                self.assertEqual(engine.kwargs["ref_audio"], str(female))
                self.assertEqual(engine.kwargs["ref_text"], "Female reference")
                self.assertEqual(client.post("/v1/audio/speech", json={"text": "Hi", "profile": "unknown"}).status_code, 422)
            self.assertEqual(engine.loads, 1)
        with TestClient(tts_app(TTSSettings(), FakeTTS())) as client:
            self.assertFalse(client.get("/health").json()["voice_profiles"]["user_male"]["configured"])
            result = client.post("/v1/audio/speech", json={"text": "Hello", "profile": "user_male"})
            self.assertEqual(result.status_code, 422)
            self.assertIn("TTS_USER_MALE_REF_AUDIO", result.json()["detail"])

    def test_emotion_capability_distinguishes_cloning_from_instruction_control(self):
        for model_id, expected in [
            ("mlx-community/VoxCPM2-8bit", "supported"),
            ("mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit", "unsupported"),
            ("mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit", "unsupported"),
            ("mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit", "supported"),
            ("other", "unknown"),
        ]:
            engine = TTSEngine(model_id)
            self.assertEqual(engine.emotion_control, expected)
            with patch.object(engine, "load"), TestClient(tts_app(TTSSettings(model_id=model_id), engine)) as client:
                self.assertEqual(client.get("/health").json()["emotion_control"], expected)

    def test_emotions_become_style_instructions_without_changing_spoken_text(self):
        engine = TTSEngine("fake")
        calls = []

        def generate(text, **kwargs):
            calls.append((text, kwargs))
            yield SimpleNamespace(sample_rate=16000, audio=np.zeros(1600))

        engine.model = SimpleNamespace(generate=generate)
        settings = TTSSettings(voice_style="A gentle young woman", ref_audio="speaker.wav")
        with patch.object(engine, "load"), TestClient(tts_app(settings, engine)) as client:
            for emotion in EMOTION_INSTRUCTIONS:
                response = client.post("/v1/audio/speech", json={"text": "你好！", "emotion": emotion})
                self.assertEqual(response.status_code, 200, response.text)
                text, kwargs = calls[-1]
                self.assertEqual(text, "你好！")
                self.assertIn(EMOTION_INSTRUCTIONS[emotion], kwargs["instruct"])
                self.assertIn(settings.voice_style, kwargs["instruct"])
                self.assertTrue(Path(kwargs["ref_audio"]).is_absolute())
                self.assertNotIn("voice", kwargs)
            self.assertEqual(client.post("/v1/audio/speech", json={"text": "Hi", "emotion": "furious"}).status_code, 422)

    def test_optional_instruction_never_turns_none_into_spoken_control_text(self):
        engine = FakeTTS()
        with TestClient(tts_app(TTSSettings(), engine)) as client:
            self.assertEqual(client.post("/v1/audio/speech", json={"text": "Hi"}).status_code, 200)
            self.assertIsNone(engine.kwargs["instruct"])
            self.assertEqual(client.post("/v1/audio/speech", json={"text": "Hi", "emotion": "sad", "instruct": "(Quietly)"}).status_code, 200)
            self.assertIn("Quietly", engine.kwargs["instruct"])
            self.assertNotIn("(", engine.kwargs["instruct"])

    def test_wav_response_metadata_and_reuse(self):
        engine = FakeTTS()
        with TestClient(tts_app(TTSSettings(), engine)) as client:
            self.assertEqual(client.get("/health").json()["voices"], ["Vivian"])
            for _ in range(2):
                response = client.post("/v1/audio/speech", json={"text": " Hello "})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["content-type"], "audio/wav")
                self.assertEqual(response.headers["x-sample-rate"], "48000")
                with wave.open(io.BytesIO(response.content), "rb") as wav:
                    self.assertEqual(wav.getframerate(), 48000)
                    self.assertEqual(wav.getnframes(), 4800)
        self.assertEqual(engine.loads, 1)
        self.assertEqual(engine.kwargs["voice"], "Vivian")

    def test_text_validation(self):
        with TestClient(tts_app(TTSSettings(max_text_chars=5), FakeTTS())) as client:
            for payload in [{}, {"text": " "}, {"text": "123456"}, {"text": "ok", "model": "other"}]:
                self.assertEqual(client.post("/v1/audio/speech", json=payload).status_code, 422)

    def test_busy_returns_429_and_health_stays_responsive(self):
        engine = FakeTTS()
        engine.block = True
        with TestClient(tts_app(TTSSettings(), engine)) as client, ThreadPoolExecutor() as executor:
            first = executor.submit(client.post, "/v1/audio/speech", json={"text": "First"})
            try:
                self.assertTrue(engine.entered.wait(3))
                self.assertTrue(client.get("/health").json()["busy"])
                second = client.post("/v1/audio/speech", json={"text": "Second"})
                self.assertEqual(second.status_code, 429)
            finally:
                engine.release.set()
            self.assertEqual(first.result(timeout=3).status_code, 200)
            self.assertFalse(client.get("/health").json()["busy"])

    def test_inference_failure_releases_slot(self):
        engine = FakeTTS()
        with TestClient(tts_app(TTSSettings(), engine)) as client:
            with patch.object(engine, "synthesize", side_effect=ValueError("Unsupported voice")):
                self.assertEqual(client.post("/v1/audio/speech", json={"text": "Hi"}).status_code, 422)
            self.assertEqual(client.post("/v1/audio/speech", json={"text": "Hi"}).status_code, 200)

    def test_multiple_chunks_clipping_and_actual_sample_rate(self):
        engine = TTSEngine("fake")
        engine.model = SimpleNamespace(generate=lambda *args, **kwargs: iter([
            SimpleNamespace(sample_rate=48000, audio=np.array([-2., 0., 2.], dtype=np.float32)),
            SimpleNamespace(sample_rate=48000, audio=np.array([123], dtype=np.int16)),
        ]))
        data, rate, duration = engine.synthesize("Hello")
        self.assertEqual(rate, 48000)
        self.assertAlmostEqual(duration, 4 / 48000)
        with wave.open(io.BytesIO(data), "rb") as wav:
            self.assertEqual(wav.getframerate(), 48000)
            self.assertEqual(np.frombuffer(wav.readframes(4), dtype="<i2").tolist(), [-32767, 0, 32767, 123])

    def test_generation_limits_and_empty_output(self):
        engine = TTSEngine("fake")
        engine.model = SimpleNamespace(generate=lambda *args, **kwargs: iter([
            SimpleNamespace(sample_rate=16000, audio=np.zeros(1600)),
        ]))
        with self.assertRaisesRegex(ValueError, "exceeds"):
            engine.synthesize("Hello", max_audio_seconds=0.01)
        engine.model = SimpleNamespace(generate=lambda *args, **kwargs: iter([]))
        with self.assertRaisesRegex(RuntimeError, "no audio"):
            engine.synthesize("Hello")


class CancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_requests_keep_worker_slot_and_audio_until_finished(self):
        for kind in ["asr", "tts"]:
            with self.subTest(service=kind):
                engine = FakeASR() if kind == "asr" else FakeTTS()
                engine.block = True
                app = asr_app(ASRSettings(), engine) if kind == "asr" else tts_app(TTSSettings(), engine)
                path = "/v1/audio/transcriptions" if kind == "asr" else "/v1/audio/speech"
                kwargs = {"files": {"file": ("question.wav", wav_bytes())}} if kind == "asr" else {"json": {"text": "Hello"}}
                async with app.router.lifespan_context(app):
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                        task = asyncio.create_task(client.post(path, **kwargs))
                        try:
                            self.assertTrue(await asyncio.to_thread(engine.entered.wait, 3))
                            task.cancel()
                            await asyncio.sleep(0)
                            task.cancel()  # repeated cancellation must not release Metal's slot
                            await asyncio.sleep(0)
                            self.assertTrue((await client.get("/health")).json()["busy"])
                            self.assertEqual((await client.post(path, **kwargs)).status_code, 429)
                            if kind == "asr":
                                self.assertTrue(engine.paths[0].exists())
                        finally:
                            engine.release.set()
                            with self.assertRaises(asyncio.CancelledError):
                                await task
                        self.assertFalse((await client.get("/health")).json()["busy"])
                        if kind == "asr":
                            self.assertFalse(engine.paths[0].exists())


if __name__ == "__main__":
    unittest.main()
