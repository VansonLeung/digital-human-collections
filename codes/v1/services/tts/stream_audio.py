"""Persistent MLX TTS engine plus the original streaming playback CLI."""

import argparse
import io
import wave

import numpy as np


class TTSEngine:
    def __init__(self, model_id):
        self.model_id = model_id
        self.model = None

    def load(self):
        from mlx_audio.tts.utils import load_model

        self.model = load_model(self.model_id)

    @property
    def voices(self):
        getter = getattr(self.model, "get_supported_speakers", None)
        return list(getter()) if getter else []

    @property
    def languages(self):
        getter = getattr(self.model, "get_supported_languages", None)
        return list(getter()) if getter else []

    def iter_pcm(self, text, voice=None, language=None, instruct=None,
                 ref_audio=None, ref_text=None, max_tokens=1024, stream=False):
        if voice and self.voices and voice.lower() not in [v.lower() for v in self.voices]:
            raise ValueError("Unsupported voice; see /health for supported voices.")
        if language and self.languages and language.lower() not in [v.lower() for v in self.languages]:
            raise ValueError("Unsupported TTS language; see /health for supported languages.")
        kwargs = {"stream": stream, "streaming_interval": 0.15,
                  "max_tokens": max_tokens, "verbose": False}
        for key, value in {"voice": voice, "lang_code": language, "instruct": instruct,
                           "ref_audio": ref_audio, "ref_text": ref_text}.items():
            if value is not None:
                kwargs[key] = value
        rate = None
        for result in self.model.generate(text, **kwargs):
            sample_rate = int(getattr(result, "sample_rate", None) or self.model.sample_rate)
            if not 8000 <= sample_rate <= 192000 or (rate and rate != sample_rate):
                raise RuntimeError("Invalid or changing TTS sample rate.")
            rate = sample_rate
            audio = np.asarray(result.audio)
            if audio.ndim == 2 and 1 in audio.shape:
                audio = audio.reshape(-1)
            if audio.ndim != 1 or not np.isfinite(audio).all():
                raise RuntimeError("TTS returned invalid mono audio.")
            if audio.size == 0:
                continue
            if audio.dtype != np.int16:
                audio = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16)
            yield sample_rate, audio.astype("<i2", copy=False).tobytes()

    def synthesize(self, text, max_audio_seconds=120, **kwargs):
        buffer = io.BytesIO()
        rate = None
        samples = 0
        with wave.open(buffer, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(24000)  # valid empty header if generation raises
            for chunk_rate, pcm in self.iter_pcm(text, **kwargs):
                if rate is None:
                    rate = chunk_rate
                    wav.setframerate(rate)
                samples += len(pcm) // 2
                if samples / rate > max_audio_seconds:
                    raise ValueError("Generated speech exceeds TTS_MAX_AUDIO_SECONDS; shorten the text.")
                wav.writeframes(pcm)
            if rate is None:
                wav.setframerate(24000)
                raise RuntimeError("TTS generated no audio.")
        return buffer.getvalue(), rate, samples / rate


def main():
    from tts_api import Settings

    settings = Settings.from_env()
    parser = argparse.ArgumentParser(description="MLX streaming TTS; optionally save a WAV")
    parser.add_argument("--model", default=settings.model_id)
    parser.add_argument("--text", required=True)
    parser.add_argument("--voice", default=None)
    parser.add_argument("--language", default=None)
    parser.add_argument("--instruct", default=None)
    parser.add_argument("--ref_audio", default=None)
    parser.add_argument("--ref_text", default=None)
    parser.add_argument("--output", default=None)
    parser.add_argument("--no-play", action="store_true", help="Generate without host speaker playback")
    args = parser.parse_args()
    engine = TTSEngine(args.model)
    engine.load()
    voice = args.voice or (settings.voice if args.model == settings.model_id else None)
    stream = None
    wav = wave.open(args.output, "wb") if args.output else None
    if wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
    wrote_audio = False
    try:
        for rate, pcm in engine.iter_pcm(
            args.text, voice=voice, language=args.language, instruct=args.instruct,
            ref_audio=args.ref_audio, ref_text=args.ref_text, stream=True,
        ):
            if wav:
                if not wrote_audio:
                    wav.setframerate(rate)
                wav.writeframes(pcm)
            if not args.no_play:
                if stream is None:
                    import sounddevice as sd

                    stream = sd.RawOutputStream(samplerate=rate, channels=1, dtype="int16")
                    stream.start()
                stream.write(pcm)
            wrote_audio = True
        if not wrote_audio:
            raise RuntimeError("TTS generated no audio.")
    finally:
        if wav:
            wav.close()
        if stream:
            stream.stop()
            stream.close()


if __name__ == "__main__":
    main()
