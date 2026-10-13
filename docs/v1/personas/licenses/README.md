# Asset provenance and usage notes

Acquired 13 October 2026 for local evaluation. Every downloaded file is recorded in [../manifest.json](../manifest.json). Model bytes are unchanged. These notes identify the applicable source terms; public use must follow those terms and the settings embedded in each model.

## VRM assets

Both come from the VRM Consortium's [official samples repository](https://github.com/vrm-c/vrm-specification/tree/94e82dd346fa6cf0337c4421728640e5252dd38e/samples), revision `94e82dd346fa6cf0337c4421728640e5252dd38e`. Upstream README files are retained in the model packages. [VRM Public License 1.0 snapshot](vrm-public-license-1.0.html); [publisher's current license](https://vrm.dev/en/licenses/1.0/).

| Setting extracted from model | Seed-san | Constraint Twist |
| --- | --- | --- |
| Author/copyright | VirtualCast, Inc. | (c) 2022 pixiv Inc. |
| Avatar permission | everyone | everyone |
| Commercial usage | corporation | corporation |
| Redistribution | allowed | allowed |
| Modification | allowModificationRedistribution | allowModificationRedistribution |
| Credit notation | required | unnecessary |
| Antisocial/hate usage | allowed by embedded flag | disallowed |

The complete settings, including other expression/use flags, are preserved in [../inspection.json](../inspection.json). The license grants rights according to each file's settings; the format or renderer license alone does not grant asset rights.

Suggested attribution to keep with any demonstration:

> Seed-san model by VirtualCast, Inc. Used under VRM Public License 1.0 and the model's embedded license settings. Source: VRM Consortium sample models.

Keep a link to the model source and license alongside the notice. Acknowledge pixiv for Constraint Twist as useful provenance even though its embedded credit setting is unnecessary.

## Live2D assets

Haru and Ren Foster come from [CubismWebSamples](https://github.com/Live2D/CubismWebSamples/tree/b1de66b0b1f1cb881d95fb6158622aeb6a2827bd), revision `b1de66b0b1f1cb881d95fb6158622aeb6a2827bd`. Copyright: **Live2D Inc.**

- [Upstream repository license](live2d-upstream-LICENSE.md).
- [Free Material License snapshot](live2d-free-material-license.html) and [current publisher agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html).
- [Sample Model Terms snapshot](live2d-sample-model-terms.html) and [current publisher terms](https://www.live2d.com/en/learn/sample/model-terms/).
- [SDK publication/release licensing](https://www.live2d.com/en/sdk/license/), including AI/chatbot and expandable-application categories. No SDK/Core is included in this collection.

The current character license distinguishes individuals/small enterprises from other enterprises. General/small-enterprise eligibility uses an annual-sales threshold of 10 million JPY, with qualifications; other enterprises have narrower sample-character use. This is separate from SDK publication licensing. A free sample download does not mean unrestricted public commercial deployment.

For a release, use the publisher's required attribution notice in full from the preserved Sample Model Terms, copyright-notice section. Its short-form notice is:

> This content uses sample data owned and copyrighted by Live2D Inc.

Preserve character-specific restrictions. These two are categorized as original characters by the current terms. The acquired Haru folder includes unchanged upstream sound files; the Free Material License separately restricts sound-data use/redistribution unless expressly permitted. They are not the assistant's TTS voice and should not be published merely because the compiled character is usable.

## MPFB human

Source: [TalkingHead, pinned model](https://github.com/met4citizen/TalkingHead/blob/2afe6d79779313db8909badebf46f9805a6c7b70/avatars/mpfb.glb), revision `2afe6d79779313db8909badebf46f9805a6c7b70`.

The preserved [upstream README](talkinghead-upstream-README.md), in its web-app asset attribution notes, explicitly identifies `mpfb.glb` as **CC0**. [CC0 legal text](CC0-1.0.txt). The repository's [MIT license](talkinghead-LICENSE.txt) is retained for repository materials, including the downloaded authoring screenshot. This does not assign CC0 to every avatar in the repository.

Suggested provenance: “MPFB human sample from met4citizen/TalkingHead, created with Blender and MPFB; model CC0.” If integrating TalkingHead code later, retain its MIT notice. Other MakeHuman/MPFB clothing and hair assets may have different terms when creating a new persona.

## Preservation and release

Keep this file, upstream notices, source links and embedded metadata when moving assets into the application. The acquisition manifest covers only third-party downloads; research documents and generated inspection metadata are maintained separately. If a new asset replaces a sample, record its author, exact version, terms, required credits, and permission for browser delivery before treating it as a deployment asset.
