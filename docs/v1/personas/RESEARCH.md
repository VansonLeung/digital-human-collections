# Research findings and recommendation

Date: 13 October 2026. Recommendations incorporate the answers in [CLARIFICATIONS.md](CLARIFICATIONS.md). Download-specific facts below come from the actual files in [inspection.json](inspection.json), not merely model listings.

## Project study

The repository is currently a speech-service foundation and a proposed chatbot architecture. The ASR and TTS implementations exist; the chatbot destination currently has environment configuration, with no implemented avatar frontend/backend. [PLAN.md](../PLAN.md) selects MuseTalk on a separate CUDA worker and excludes 3D from its original scope. Your preference for local stylized 3D and Live2D changes that rendering decision.

| Existing component | Finding | Consequence |
| --- | --- | --- |
| [Shared services](../../../codes/v1/services/README.md) | Two persistent FastAPI services, localhost ports 8001/8002, one inference request per service; no browser CORS | Keep calls behind the future chatbot backend. Respect busy responses. |
| [ASR](../../../codes/v1/services/asr/asr_api.py) and [engine](../../../codes/v1/services/asr/asr_audio.py) | Qwen3-ASR; optional Qwen forced alignment; English/Chinese/Cantonese language normalization | Good input foundation. Input timestamps describe the user's recording, not the assistant's response. |
| [TTS endpoint](../../../codes/v1/services/tts/tts_api.py) | Returns a complete mono PCM16 WAV with actual sample rate and duration headers | This exact WAV can drive all proposed renderers. No TTS service redesign is needed for a first comparison. |
| TTS timing | HTTP buffers the complete utterance; no viseme/phoneme timeline is returned | Add an audio-analysis adapter. Browser animation removes the video-generation step but cannot remove current TTS buffering. |
| Existing configuration | `mlx-audio==0.5.0`, configurable speech models, configurable LLM endpoint | Preserve the working environments; evaluate additional engines separately. Local avatars do not imply a local LLM. |

The earlier plan records individual English speech checks, including about 3.40 seconds of synthesis for a 5.20-second WAV. Those are historical single observations, not sustained benchmarks. During this study the default health endpoints were unreachable; no new speech synthesis, language-quality benchmark, or service-code test run was performed.

## Hardware interpretation

The local host reports M1 Max, 64 GB unified memory, and integrated Apple graphics. “No GPU cards” therefore need not prevent 3D: the browser can render one ordinary avatar using integrated graphics. The existing MLX services also use Apple acceleration. This is distinct from a machine with no GPU acceleration at all.

My engineering expectation is that one modest avatar is feasible on this hardware. It is still necessary to measure browser rendering while TTS/ASR run, since they share memory and resources. Start with a modest canvas resolution and capped device pixel ratio; avoid expensive postprocessing, high-resolution shadows, and unnecessarily dense hair.

## Approach comparison

| Approach | Face control | Local hardware fit | Advantages | Limits and recommendation |
| --- | --- | --- | --- | --- |
| **VRM + Three.js/three-vrm** | Named vowel, blink, gaze, emotion expressions; underlying morphs/bones | Integrated WebGL graphics; CPU audio analysis | Consistent avatar conventions, approachable customization, stable identity | **First choice for stylized 3D.** Sample vowel controls are less detailed than a full speech rig. |
| **Live2D + Cubism Web SDK** | Deformed 2D mesh parameters; supplied samples have mouth opening and mouth form | Integrated graphics; low geometric complexity, texture costs still matter | Strong illustrated presentation, expressive idle motions | **Preferred illustrated alternative.** Sample mouth form is not a complete vowel/consonant rig. SDK and character terms both apply. |
| **GLB human + Three.js, optionally TalkingHead** | Explicit facial/viseme morphs and skeleton | Integrated graphics; profile material/mesh cost | Richer facial deformation and greater control over lip closure | Downloaded CC0 MPFB model provides a useful comparison. Heavier than the VRM samples and requires model-specific setup. |
| **2D sprites or SVG/Canvas character** | Swap drawn mouth shapes, blink frames; simple transforms | Lowest rendering/processing burden; can work without hardware-accelerated 3D | Predictable performance, easy original branding | Feasible fallback. Needs original mouth drawings/rigging; a single portrait does not supply those automatically. |
| **Neural talking-head video** | Generated face pixels from portrait/video and audio | Model/runtime dependent; many popular implementations target CUDA | Potentially photorealistic | Poor first fit for the local constraint. MuseTalk's documented GPU benchmark is not evidence of live operation on this Mac. |
| **Managed talking-avatar service** | Provider-rendered video | Remote service | Possible realism without buying a card | Excluded by your local-only preference. |

VRM defines facial expression presets, and three-vrm exposes an expression manager for animation. A VRM preset can combine several underlying targets; using that abstraction preserves model-specific bindings. [VRM expression specification](https://vrm.dev/en/vrm1/expression/), [three-vrm API](https://pixiv.github.io/three-vrm/docs/classes/three-vrm.VRMExpressionManager.html).

Live2D documents audio-level-to-mouth-parameter control. This produces speech-reactive movement; it does not by itself distinguish phonemes. The downloaded models' parameter inventories are recorded locally. [Cubism lip-sync manual](https://docs.live2d.com/en/cubism-sdk-manual/lipsync/).

A skeleton used for walking does not establish facial capability. When choosing another model, require demonstrable mouth targets, a jaw/lip bone rig, or a deformable 2D mouth. A neutral scan, OBJ, static GLB, or body-only auto-rig cannot simply be made to speak by loading it.

## Mouth animation without a CUDA worker

Three feasible levels should be compared:

1. **Audio envelope baseline:** calculate loudness from the outgoing WAV and smoothly control mouth openness. Cheap and independent of text language, but cannot distinguish a closed-lip /m/ from an open vowel. Label it as a baseline.
2. **CPU-generated timed mouth cues:** Rhubarb analyzes WAV/OGG into timed mouth categories. Use its English recognizer for English and its language-independent `phonetic` recognizer for Mandarin/Cantonese. This is my proposed first cue generator; its non-English accuracy and processing delay need measurement. Map the cues to the rig's available controls. [Rhubarb documentation](https://github.com/DanielSWolf/rhubarb-lip-sync).
3. **Browser audio-to-viseme detection:** HeadAudio offers an MIT-licensed AudioWorklet classifier and Oculus-style output. It avoids an extra server analysis pass. Its supplied model is English-oriented and its author documents accuracy limits; Chinese/Cantonese quality is unverified. Evaluate it after a reliable baseline, especially with the richer GLB model. [HeadAudio](https://github.com/met4citizen/HeadAudio).

Text/forced alignment is another route when more precision is necessary. Qwen's aligner lists English, Chinese, and Cantonese, but aligned words/characters are not phoneme or viseme IDs. Accurate conversion would additionally need language-specific pronunciation processing and within-word timing. [Qwen forced-aligner language table](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B).

## English, Mandarin, and Cantonese

Evaluate **recognition, spoken language, and visual synchronization separately**. Model geometry has no inherent spoken language; the voice engine and cue generator establish the language behavior.

The current Qwen CustomVoice model lists English and Chinese among its supported languages; Vivian/Serena are Chinese-native presets, while Ryan/Aiden are English-native presets. Cantonese is not separately listed in that model's language list. That is insufficient evidence to promise native Cantonese output. Keep the existing model for initial English/Mandarin checks and test colloquial Cantonese with a fluent listener. [Qwen CustomVoice model card](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice).

If that test fails, **Fun-CosyVoice3 is a local evaluation candidate**: its publisher describes Chinese dialect coverage and instruction controls. An MLX conversion exists, but its card targets **mlx-audio-plus** and reference-audio modes. Treat it as a separate environment/adapter experiment, using an authorized reference voice; do not assume changing this project's `TTS_MODEL_ID` alone makes it work. It has not been downloaded or benchmarked here. [Publisher checkpoint](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512), [MLX conversion and usage](https://huggingface.co/mlx-community/Fun-CosyVoice3-0.5B-2512-4bit).

Cantonese tones mainly affect sound rather than requiring one visible mouth target per tone. Nevertheless, a five-vowel rig loses some articulatory detail, and English-trained audio classification is not a demonstrated substitute for Cantonese evaluation. Include colloquial particles, numbers, names, and English code-switching in the test set.

## Sources for additional identities

| Source | What to obtain | Acquisition and suitability |
| --- | --- | --- |
| [Official VRM samples](https://github.com/vrm-c/vrm-specification/tree/master/samples) | Complete `.vrm` files with facial expressions | Two practical avatars downloaded. Preserve embedded metadata and per-model rights. |
| [VRoid Studio](https://vroid.com/en/studio) | Create an original stylized persona and export VRM | Strong next step for a distinctive assistant; check all third-party clothing/hair rights. |
| [VRoid Hub](https://hub.vroid.com/en/) | Creator-published VRM identities | Download permission varies per listing; some are usable only through integrated apps. Do not treat a viewable model as downloadable. |
| [Official Live2D samples](https://www.live2d.com/en/learn/sample/) and [SDK resources](https://github.com/Live2D/CubismWebSamples) | Ready-to-load `.moc3` packages | Haru and Ren downloaded; preserve their dependencies and attribution. |
| [nizima](https://nizima.com/) | Commission or purchase Live2D art and rigging | Require Cubism Web compatibility, desired mouth parameters, and application redistribution rights. A PNG or layered PSD alone is insufficient. |
| [MPFB/MakeHuman](https://static.makehumancommunity.org/mpfb.html) | Author human geometry and facial targets in Blender | Good open-source creation workflow. Asset licenses vary; check the selected clothing/hair packs. |
| [Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox) | Diverse rigged humans, including facial blendshape variants | MIT library; requires selecting the correct variant and converting/retargeting for the web. Not downloaded because the ready GLB/VRM samples cover the first comparison. |

For a commission, request the actual runtime package, mouth/eye/emotion controls, a reference neutral pose, texture/material budget, and permission to deliver model bytes to a browser. Require a short demo driven by supplied English/Mandarin/Cantonese WAVs before accepting the asset.

**Avoid a new Ready Player Me dependency.** Its public service closed on 31 January 2026; existing GLBs and their licenses are a separate matter. [Genies' integration notice](https://docs.genies.com/docs/sdk-unity/sdk-avatar/other-platforms/ready-player-me/). TalkingHead is still an independent renderer worth evaluating, but its sample assets have different licenses. [TalkingHead asset notes](https://github.com/met4citizen/TalkingHead#readme).

For this task, only free public sample packages and their provenance were downloaded. No cloud account, paid model, neural-video weights, or SDK runtime was installed. [The catalog](MODELS.md) identifies what is ready for loader integration and what still needs runtime evaluation.
