# Local persona models and research

Research date: **13 October 2026**, Asia/Hong_Kong.

**Recommendation: start with the downloaded VRM Constraint Twist model and Three.js + `@pixiv/three-vrm`; evaluate Haru or Ren Foster with the official Cubism Web SDK as the Live2D alternative.** Both approaches animate existing geometry in the browser and avoid generating a video for every reply. Use the existing local ASR/TTS services, with a separate audio-to-mouth adapter.

Your clarified preferences are **stylized 3D and Live2D**, **entirely local with free samples first**, and **English, Mandarin, Cantonese**. Photorealistic neural video and paid cloud avatars are therefore outside the proposed first implementation. Private versus public/commercial use is still unspecified; each asset's terms are recorded below.

The host inspected for this study is an **Apple M1 Max MacBook Pro with 64 GB unified memory and a 32-core integrated GPU**. It can use Metal/WebGL without a separate graphics card. This recommendation does use integrated graphics; it is not a claim of CPU-only 3D rendering or measured frame rate.

## What is here

| File | Purpose |
| --- | --- |
| [RESEARCH.md](RESEARCH.md) | Project findings, approach comparison, acquisition sources, and language considerations |
| [MODELS.md](MODELS.md) | Five downloaded models, entry points, previews, measured file properties, and usage notes |
| [INTEGRATION.md](INTEGRATION.md) | Proposed speech-to-face architecture and a concrete local evaluation procedure |
| [CLARIFICATIONS.md](CLARIFICATIONS.md) | Recorded answers, working assumptions, and remaining decisions |
| [licenses/README.md](licenses/README.md) | Attribution, embedded VRM permissions, and upstream license snapshots |
| [manifest.json](manifest.json) | Exact download URLs, source revisions, byte sizes, and SHA-256 hashes |
| [inspection.json](inspection.json) | Repeatable checks and extracted mouth/expression metadata |
| [scripts/assets.py](scripts/assets.py) | Standard-library download and verification utility |

## Downloaded shortlist

| Model | Type | Package size¹ | Suggested use |
| --- | --- | --- | --- |
| [Constraint Twist](models/vrm/constraint-twist/) | VRM 1.0, stylized human | 10.36 MiB | First 3D presenter; five vowel expressions and facial emotions |
| [Seed-san](models/vrm/seed-san/) | VRM 1.0, stylized human | 10.46 MiB | Second 3D persona and compatibility comparison |
| [Haru](models/live2d/haru/) | Live2D, illustrated female | 4.08 MiB | First Live2D presenter |
| [Ren Foster](models/live2d/ren/) | Live2D, illustrated male | 2.41 MiB | Second Live2D persona |
| [MPFB human](models/glb/mpfb-human/) | GLB, conventional human mesh | 35.36 MiB | Extra CC0 comparison with more detailed speech blendshapes |

¹ Includes each model's downloaded supporting files/previews. **75 upstream files, 62.87 MiB total**, including shared license/provenance files. Source model bytes are unchanged. Live2D packages contain compiled runtime data, textures, motions, and expressions, rather than editable Cubism project files.

**Verified:** download hashes/sizes, GLB headers/chunk lengths, embedded resources, morph-target inventories, VRM metadata, Live2D MOC3 signatures, and every resource referenced by the two `.model3.json` files. **Still to evaluate:** runtime rendering, visual deformation, lip-sync accuracy, frame rate under speech inference, and Mandarin/Cantonese voice quality. Upstream screenshots in the catalog are not results of a local renderer test.

## Recheck or restore files

Run from the project root with Python 3.9+; no extra packages are needed:

```bash
python3 docs/v1/personas/scripts/assets.py verify
python3 docs/v1/personas/scripts/assets.py fetch
```

`fetch` restores missing files and then verifies the collection. It preserves existing files and rejects a checksum mismatch. Repository downloads use pinned commits. License HTML snapshots use live publisher URLs, so a publisher's later page change may prevent byte-identical restoration; the tool reports that mismatch instead of silently accepting new terms.

Verification passed for all 75 upstream files and all local documentation links. The download utility also passed a temporary-directory check that restored a missing pinned file, rejected an escaping path, and preserved a modified file while reporting its checksum mismatch.

## Suggested next implementation

Render Constraint Twist and Haru with the same short TTS WAVs, compare appearance and mouth movement, then select the default persona. Use CPU Rhubarb cues for the first language comparison; keep simple volume-driven movement as a clearly labeled baseline. Detailed consonant shaping would favor a richer GLB/VRM rig or a custom Live2D rig. See [the evaluation steps](INTEGRATION.md#evaluation-and-acceptance).

This research revises the avatar direction of [the earlier plan](../PLAN.md), which assumed a photorealistic presenter and a remote CUDA worker. The speech code and earlier plan have not been rewritten by this research task. In particular, their existing acceptance criteria reject volume-only mouth movement as completed lip-sync; that distinction remains useful here.
