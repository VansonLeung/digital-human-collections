# Qwen ASR API

Uses `QWEN_ASR_MODEL_ID` from this directory's `.env`, defaulting to
`mlx-community/Qwen3-ASR-1.7B-bf16`. Forced alignment uses
`QWEN_ASR_ALIGNER_MODEL_ID`; it is enabled by default to match the existing
configuration. Both models load once before the server accepts requests.

## Start

Prerequisites: Apple Silicon, Python 3.10+, FFmpeg, and model weights (downloaded
by MLX on first load if not already cached). For a fresh environment:

```bash
cd codes/v1/services/asr
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[test]'
# If .env is absent, create it from .env.example; retain existing settings.
python asr_api.py
```

Or use the existing common interpreter from the ASR directory, after ensuring
the dependencies in `pyproject.toml` are installed:

```bash
~/.common-venv/python3.12/bin/python asr_api.py
```

The default address is `http://127.0.0.1:8001`. `ASR_HOST` and `ASR_PORT` are
configurable. `digital-human-asr` is also installed as a launch command.
Startup fails visibly if model loading fails or FFmpeg cannot be found.

## Transcribe

```bash
curl --fail-with-body http://127.0.0.1:8001/health
curl --fail-with-body http://127.0.0.1:8001/v1/audio/transcriptions \
  -F 'file=@/path/to/question.wav' \
  -F 'language=English' \
  -F 'align=true'
```

Multipart fields:

| Field | Behavior |
| --- | --- |
| `file` | Required uploaded recording; WAV, MP3, M4A, WebM/Opus, and other audio containers supported by installed FFmpeg. |
| `language` | Optional; omit or use `auto` for detection. Accepts model language names and aliases `en`, `zh`, `yue`, `zh-HK`, `ja`, `ko`. |
| `align` | Optional boolean; defaults to the service alignment setting. Use `false` for faster transcription without timestamps. Requesting `true` when alignment is disabled returns 422. |

Example response (timestamps are illustrative):

```json
{
  "text": "Hello.",
  "language": "English",
  "segments": [{"text": "Hello.", "start": 0.0, "end": 1.2}],
  "words": [{"text": "Hello", "start": 0.1, "end": 0.8}],
  "alignment_performed": true,
  "duration_seconds": 1.2,
  "processing_seconds": 0.9
}
```

`words` are aligned units (words or CJK characters), in seconds. `segments`
come from ASR and are not necessarily word-level timestamps. An empty transcript
returns no aligned words. Mixed-language output may have no single top-level
`language`; supply a language explicitly when alignment needs one.

Uploads are normalized to 16 kHz mono PCM16 in a unique temporary directory,
deleted after the request finishes. Defaults: 20 MiB upload, 60 seconds audio,
30 seconds FFmpeg decode timeout; see `.env.example` for settings. Invalid audio
returns 422, file/duration limits return 413, decode timeout returns 408, busy
returns 429, and unexpected inference errors return 500 with details in logs.
An HTTP disconnect does not interrupt Metal inference; the service retains the
inference slot and input file until that work completes.

## File CLI

```bash
python asr_audio.py /path/to/question.wav --language English --align
python asr_audio.py /path/to/one.wav /path/to/two.wav --no-align
```

The CLI prints JSON without writing transcript files. Unlike the API, the local
CLI delegates audio loading directly to MLX and does not apply HTTP upload limits.
