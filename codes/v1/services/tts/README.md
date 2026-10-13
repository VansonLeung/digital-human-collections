# MLX TTS API

Loads one model at startup and returns a complete mono PCM16 WAV for each answer.
The API never plays audio on the Mac. The default model is
`mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit`, with voice `Vivian`.
Change `TTS_MODEL_ID`, `TTS_VOICE`, and `TTS_LANGUAGE` in `.env` as needed.

## Start

Prerequisites: Apple Silicon, Python 3.10+, and model weights (downloaded by MLX
on first load if not cached). For a fresh environment:

```bash
cd codes/v1/services/tts
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[test]'
# If .env is absent, create it from .env.example; retain existing settings.
python tts_api.py
```

Or use the existing common interpreter from the TTS directory, after ensuring
the dependencies in `pyproject.toml` are installed:

```bash
~/.common-venv/python3.12/bin/python tts_api.py
```

The default address is `http://127.0.0.1:8002`. Configure `TTS_HOST`/`TTS_PORT`
to change it. `digital-human-tts` is also installed as a launch command.

## Synthesize

```bash
curl --fail-with-body http://127.0.0.1:8002/health
curl --fail-with-body http://127.0.0.1:8002/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello. How can I help you?","voice":"Vivian","language":"english"}' \
  --output speech.wav
```

JSON fields:

| Field | Behavior |
| --- | --- |
| `text` | Required, nonblank; defaults to a 2,000-character service limit. |
| `voice` | Optional; defaults to `TTS_VOICE`. Supported voices are listed by `/health`. |
| `language` | Optional; defaults to `TTS_LANGUAGE=auto`. Use model values such as `english` and `chinese`; inspect `/health`. |
| `instruct` | Optional voice style instruction for models that support it. |

The result has `Content-Type: audio/wav`. Response headers include
`X-Sample-Rate`, `X-Audio-Duration` (seconds), and `X-Processing-Seconds`.
The WAV header uses the generated chunk's actual sample rate, rather than a
model-name guess. Multiple chunks are joined without per-chunk normalization.

HTTP synthesis buffers the full utterance; it is not an HTTP audio stream.
Defaults cap output at 120 seconds and generation at 1,024 tokens per model
segment. These limits are configured in `.env.example`. Keep replies short for
the digital human demo. Invalid text/voice/language or output duration returns
422, busy returns 429, and unexpected model failures return 500 with details in
logs. An HTTP disconnect does not interrupt Metal inference; later requests
remain blocked until it completes.

The request cannot switch models or name local reference-audio paths. For another
model, change the service configuration and restart; clear `TTS_VOICE` if it does
not provide preset voices. Reference-audio cloning remains a local CLI feature.
Language and voice capabilities vary by model; Chinese support alone does not
establish Cantonese synthesis quality.

## Streaming file/playback CLI

The previous model, instruction, reference-audio, and output arguments remain:

```bash
python stream_audio.py --text 'Hello.' --voice Vivian --output speech.wav --no-play
python stream_audio.py --model /path/to/model --text 'Hello.' \
  --ref_audio /path/to/reference.wav --ref_text 'Reference transcript'
```

The CLI still streams to the host speaker unless `--no-play` is supplied.
`sounddevice` is only imported when CLI playback is requested; the API does not
open an audio device. Model failures now exit visibly rather than being swallowed.
