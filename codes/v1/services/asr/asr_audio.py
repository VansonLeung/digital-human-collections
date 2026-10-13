"""Reusable Qwen ASR engine and file transcription CLI. No inference on import."""

import argparse
import json


LANGUAGE_ALIASES = {
    "en": "English", "zh": "Chinese", "zh-cn": "Chinese",
    "zh-tw": "Chinese", "mandarin": "Chinese", "yue": "Cantonese",
    "zh-hk": "Cantonese", "ja": "Japanese", "ko": "Korean",
}


def normalize_language(language):
    if not language or language.strip().lower() == "auto":
        return None
    value = language.strip()
    return LANGUAGE_ALIASES.get(value.lower(), value.title())


class ASREngine:
    def __init__(self, model_id, aligner_model_id=None):
        self.model_id = model_id
        self.aligner_model_id = aligner_model_id
        self.model = None
        self.aligner = None

    def load(self):
        from mlx_audio.stt.utils import load_model

        self.model = load_model(self.model_id)
        if self.aligner_model_id:
            self.aligner = load_model(self.aligner_model_id)

    @property
    def languages(self):
        getter = getattr(self.model, "get_supported_languages", None)
        if getter:
            return list(getter())
        # mlx-audio 0.5.0 exposes these through Qwen's config instead.
        config = getattr(self.model, "config", None)
        return list(getattr(config, "support_languages", None) or [])

    def transcribe(self, audio_path, language=None, align=False):
        language = normalize_language(language)
        if language and self.languages and language.lower() not in [x.lower() for x in self.languages]:
            raise ValueError("Unsupported ASR language; see /health for supported languages.")
        if align and self.aligner is None:
            raise ValueError("Forced alignment is disabled on this service.")
        # Calling generate directly avoids the file-oriented helper's transcript
        # writes and the old, unsupported audio_path argument.
        result = self.model.generate(audio=str(audio_path), language=language, verbose=False)
        text = result.text.strip()
        detected = getattr(result, "language", None)
        # mlx-audio 0.5 may return a language list (one entry per segment).
        detected = detected if isinstance(detected, list) else [detected]
        languages = {normalize_language(item) for item in detected if item}
        detected_language = next(iter(languages)) if len(languages) == 1 else language
        words = []
        if align and text:
            alignment_language = language or normalize_language(detected_language)
            if alignment_language is None:
                raise ValueError("Specify language to align a transcript without a detected language.")
            aligned = self.aligner.generate(
                audio=str(audio_path), text=text, language=alignment_language,
            )
            words = [
                {"text": item.text, "start": float(item.start_time), "end": float(item.end_time)}
                for item in aligned
            ]
        return {
            "text": text, "language": detected_language,
            "segments": getattr(result, "segments", None) or [], "words": words,
            "alignment_performed": bool(align and text),
        }


def main():
    from asr_api import Settings

    settings = Settings.from_env()
    parser = argparse.ArgumentParser(description="Transcribe local audio with Qwen3-ASR")
    parser.add_argument("audio", nargs="+")
    parser.add_argument("--language", default=None)
    parser.add_argument("--align", action=argparse.BooleanOptionalAction,
                        default=settings.enable_alignment)
    args = parser.parse_args()
    engine = ASREngine(settings.model_id, settings.aligner_model_id if args.align else None)
    engine.load()
    for path in args.audio:
        print(json.dumps(engine.transcribe(path, args.language, args.align), ensure_ascii=False))


if __name__ == "__main__":
    main()
