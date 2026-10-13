# Available speech services and Express integration

Studied and checked on 13 October 2026. This document is based on the actual ASR/TTS source, local nonsecret service settings, READMEs, and existing contract tests. It describes the integration to implement; the Express application is not built yet.

## Process boundary and current availability

Use **Node.js + Express + TypeScript** for the chatbot backend. Keep the two existing **Python + FastAPI + MLX** processes as local inference services. Express handles sessions, LLM calls, uploads, media, mouth cues and browser events; speech models load in their own persistent processes.

| Service | Current local `.env` selection | Code / `.env.example` default | Observed health |
| --- | --- | --- | --- |
| ASR | `http://127.0.0.1:38001` | `http://127.0.0.1:8001` | Connection refused on configured port |
| TTS | `http://127.0.0.1:38002` | `http://127.0.0.1:8002` | Connection refused on configured port |

The default ports also refused connections. The APIs exist in source, but no listener was reachable at those four addresses during this study. This is a point-in-time observation, not an inference failure. Process environment variables can override the local settings, so configure the Express URLs to match the actual launch configuration.

Both services expose `GET /health`, `/docs` and `/openapi.json`. Models load before startup completes. Health reports `status: "ready"` and `busy`, rather than a `ready` boolean. ASR also reports `model`, `forced_alignment` and `languages`; TTS reports `model`, `voices` and `languages`. Treat a reachable ready/busy service separately from an unreachable service, and still handle a racing HTTP 429 after a health check.

## ASR: existing capabilities

Sources: [asr_api.py](../services/asr/asr_api.py), [asr_audio.py](../services/asr/asr_audio.py), [README](../services/asr/README.md), [example settings](../services/asr/.env.example).

The inspected local model setting is `mlx-community/Qwen3-ASR-1.7B-bf16`; forced alignment is enabled with `mlx-community/Qwen3-ForcedAligner-0.6B-8bit`. These match the model defaults in source. This study did not load the weights or query a running model's language list.

**Request:** `POST /v1/audio/transcriptions`, multipart form data.

| Field | Existing contract | Express recommendation |
| --- | --- | --- |
| `file` | Required uploaded audio | Forward the browser recording as a multipart file with a filename and MIME type. |
| `language` | Optional; omitted/`auto` enables detection; aliases include `en`, `zh`, `mandarin`, `yue`, `zh-HK` | Send the selected UI language explicitly where appropriate. |
| `align` | Optional boolean; defaults to service configuration | Send the string `"false"` for transcript review. Request alignment only when timestamps are needed. |

The service uses FFmpeg to decode recordings into **16 kHz, mono, PCM16 WAV**. Browser WebM/Opus or MP4/M4A can be forwarded if that FFmpeg installation supports the container/codec. Node does not need to decode them first. MIME type alone is not proof of valid audio; ASR performs the decode validation.

Default limits are **20 MiB**, **60 seconds** of decoded audio and **30 seconds** for FFmpeg decoding. These are configurable, and `/health` does not advertise the limits. Give the browser/Express upload path matching or stricter configured limits. Use route-scoped Multer with one file, bounded fields and a bounded file size. For this single-user prototype, bounded memory storage is an option; use temporary disk storage when avoiding simultaneous in-memory upload copies matters.

**Response:** JSON containing `text`, `language`, `segments`, `words`, `alignment_performed`, `duration_seconds`, `processing_seconds`. An empty transcript is possible and must not automatically become a user message. `language` may be null for mixed-language output; words can be aligned words or CJK characters. They are not phoneme/viseme timings.

`align=false` skips the alignment pass for that request, but the configured aligner still loads at startup and occupies memory. Disabling its startup load requires changing `QWEN_ASR_ENABLE_FORCED_ALIGNMENT` and restarting that service.

## TTS: existing capabilities

Sources: [tts_api.py](../services/tts/tts_api.py), [stream_audio.py](../services/tts/stream_audio.py), [README](../services/tts/README.md), [example settings](../services/tts/.env.example).

The inspected local selection is `mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit`, default voice **Vivian**, language **auto**. A model is loaded once at startup and reused.

**Request:** `POST /v1/audio/speech`, `Content-Type: application/json`.

```json
{
  "text": "Hello. How can I help you?",
  "voice": "Vivian",
  "language": "english",
  "instruct": "Speak calmly."
}
```

`text` is required and must remain nonblank after trimming. The other fields are optional. Voice/language values should follow the running service's `/health` list; style instruction support depends on the model. Unknown JSON fields are rejected. The schema allows up to 10,000 characters, but the service's default effective limit is **2,000**; enforce that smaller configured limit in the application.

**Response:** complete binary **`audio/wav`**, mono PCM16. Headers:

- `X-Sample-Rate`: actual generated sample rate.
- `X-Audio-Duration`: audio seconds.
- `X-Processing-Seconds`: inference processing seconds.
- `Content-Disposition`: inline `speech.wav`.

Use `response.arrayBuffer()`/binary stream handling in Node, rather than JSON or text decoding. Save the original WAV for mouth-cue analysis and browser playback. Header numbers are strings and should be parsed/validated; the WAV header is the audio-format source of truth. Do not assume the rate is 24 kHz from the model name.

Defaults cap generated output at **120 seconds** and **1,024 tokens per model segment**. The endpoint buffers the full utterance before returning it. Its CLI can stream/play locally, but that does not make the HTTP endpoint a streaming-audio API. A streaming Node proxy cannot make this upstream synthesis begin earlier.

The HTTP API does not expose per-request model selection, reference-audio cloning, voice uploads, word/phoneme/viseme timings, or an inference cancellation endpoint. The local CLI's extra features are separate. Use the HTTP service for the chatbot instead of spawning its Python CLI for every answer and repeatedly loading a model.

## Node client implementation

Suggested application modules:

| Module | Responsibility |
| --- | --- |
| `services/asr.ts` | Multipart forwarding, transcript response validation and language normalization |
| `services/tts.ts` | JSON synthesis request, binary WAV handling and timing metadata |
| `services/http.ts` | Shared timeout/cancellation composition, bounded retry and upstream error mapping |
| `services/lipsync.ts` | Asynchronous Rhubarb subprocess and timed cue conversion |

Minimal ASR forwarding shape, after Express has applied upload limits:

```typescript
const form = new FormData();
form.append("file", new Blob([recordingBytes], { type: recordingType }), filename);
form.append("language", selectedLanguage); // e.g. "en", "zh", "yue"
form.append("align", "false");

const response = await fetch(`${asrBaseUrl}/v1/audio/transcriptions`, {
  method: "POST", body: form, signal,
});
// Check response.ok, parse the upstream error if needed, then validate JSON.
```

Here `recordingBytes` is a bounded `Uint8Array`, and `signal` combines stage timeout and turn cancellation. Native FormData generates its own multipart boundary; do not set a manual multipart `Content-Type` header.

Minimal TTS response handling:

```typescript
const response = await fetch(`${ttsBaseUrl}/v1/audio/speech`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: speechText, voice, language }),
  signal,
});
// Check response.ok and Content-Type before reading/serving audio.
const wav = Buffer.from(await response.arrayBuffer());
```

These are adapter sketches, not complete error-handling implementations. Normalize trailing slashes in configured base URLs. Use `AbortSignal.any` to combine a per-turn controller with a stage timeout, and keep that signal active while consuming the response body. A finite maximum response size should protect media buffering. Use the Node HTTP server with Express plus `ws` for browser control events; Express itself is not a WebSocket server.

References: [Node globals: fetch/FormData/AbortSignal](https://nodejs.org/api/globals.html), [Multer route-scoped uploads](https://expressjs.com/en/resources/middleware/multer/), [ws server examples](https://github.com/websockets/ws).

## Errors, busy state and Stop behavior

| Existing response | Meaning | Application behavior |
| --- | --- | --- |
| 413, ASR | Upload or decoded duration exceeds limits | Explain the limit and ask for a shorter recording. |
| 408, ASR | FFmpeg decode timeout | Show a decode failure; keep typed input available. |
| 422, ASR | Invalid audio, invalid language/alignment, or validation failure | Show an actionable validation error. |
| 422, TTS | Invalid text, unsupported voice/language, or generated duration limit | Preserve the answer text and offer a supported speech choice or shorter answer. |
| 429, both | Inference slot occupied; `Retry-After: 1` | Apply bounded, abortable retry while the turn is active. |
| 500, both | Inference failure; details logged in service | Preserve the conversation and expose an explicit retry/error state. |
| Network error / client timeout | No response within application deadline | Report the affected component; avoid claiming its inference was cancelled. |

Each process permits **one active inference request**; ASR and TTS have independent slots. Do not create an unbounded Node work queue or retry arbitrary validation/authentication errors. Network timeout retries can duplicate model work; reserve automatic retries for known retryable conditions.

Stop the browser audio immediately, abort pending Node network/subprocess work, and invalidate the turn. Python inference can continue after HTTP cancellation; it keeps its slot until completion. A new turn may therefore still receive 429. Discard late audio/cues and remove temporary media when no live task needs it. Cleanup must also cover failure, Stop, session expiry and application shutdown.

## Languages and facial animation

Use explicit mappings: English UI → ASR `English`/`en` and TTS `english`; Mandarin → ASR `Chinese`/`zh` and TTS `chinese`; Cantonese → ASR `Cantonese`/`yue` and a separately verified TTS configuration. Case-insensitive adapter validation does not establish the underlying model's pronunciation quality.

The ASR normalizer includes Cantonese aliases. The TTS endpoint accepts only the loaded engine's capabilities and has no special Cantonese adapter. Good Cantonese transcription does not establish good Cantonese synthesis. Check the actual language/preset lists after startup and use listening tests before enabling Cantonese voice mode.

Neither HTTP service produces mouth cues. Analyze the **assistant's generated WAV** with the proposed local lip-sync component and drive VRM/Live2D from the same playback clock. The user's ASR alignment timestamps refer to a different recording and cannot synchronize the assistant's response.

## Launch and verification

Start the speech services in separate terminals using their documented Python environments:

```bash
cd codes/v1/services/asr
~/.common-venv/python3.12/bin/python asr_api.py
```

```bash
cd codes/v1/services/tts
~/.common-venv/python3.12/bin/python tts_api.py
```

With the inspected local settings, readiness checks are:

```bash
curl --fail-with-body http://127.0.0.1:38001/health
curl --fail-with-body http://127.0.0.1:38002/health
```

The `.env.example` files describe fresh-install defaults; they should not overwrite the current local service settings. Use one Uvicorn worker per speech service to avoid duplicate model loads.

**Verification in this study:** all **13 existing contract tests passed**, using fake speech models and real FFmpeg. Coverage includes audio normalization/cleanup, upload and duration limits, model reuse, Qwen capability/aligner compatibility, WAV rate/metadata, busy responses, inference failures, multiple chunks and repeated cancellation. The run also emitted AnyIO memory-stream ResourceWarnings; these did not fail the suite and are not evidence of a real-model playback benchmark.

Command run from the project root:

```bash
~/.common-venv/python3.12/bin/python -m unittest discover -s codes/v1/services/tests -v
```

No speech models were started/downloaded, no new real-model synthesis or latency benchmark was run, and no Node application runtime was created in this revision. Next, start the existing services and validate the Express adapters against their live OpenAPI/health responses and a short three-language listening set.
