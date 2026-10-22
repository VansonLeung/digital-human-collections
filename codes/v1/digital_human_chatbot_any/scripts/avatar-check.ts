import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));

const qa = path.join(root, 'runtime/qa');

await mkdir(qa, { recursive: true });

const server = await createServer({
  configFile: false,
  root: path.join(root, 'frontend'),
  appType: 'custom',
  optimizeDeps: { include: ['three', 'three/addons/loaders/GLTFLoader.js', '@pixiv/three-vrm'] },
  server: { host: '127.0.0.1', port: 0 },
});

server.middlewares.use((req, res, next) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<html><body style="margin:0;background:#eee"><div id="avatar" style="width:800px;height:900px"></div></body></html>',
    );
    return;
  }
  next();
});

await server.listen();

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
});

try {
  const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls!.local[0]);
  await page.evaluate('globalThis.__name = (value) => value');
  for (const [id, url] of [
    ['mira', '/personas/constraint-twist/vrm/VRM1_Constraint_Twist_Sample.vrm'],
    ['seed-san', '/personas/seed-san/vrm/Seed-san.vrm'],
  ]) {
    const result = await page.evaluate(
      async ({ url }) => {
        const moduleUrl = '/src/avatars/VrmRenderer.ts';
        const { VrmRenderer } = await import(moduleUrl);
        const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const renderer = new VrmRenderer(document.getElementById('avatar')!);
        await renderer.load(url);
        // Inspect the real loaded rig: gestures must move bones, keep the root
        // stationary, and return both hands to their captured rest rotations.
        const bone = (name: string) => renderer.vrm.humanoid.getNormalizedBoneNode(name);
        const rotation = (name: string) => bone(name).rotation.toArray().slice(0, 3);
        const manager = renderer.vrm.expressionManager;
        const smile = () => manager.getValue('talk-happy');
        // Probe actual deformed vertices, not just the aa control weight: a
        // whole-face emotion can hold the lips open even when aa is zero.
        const meshes = new Set<any>();
        for (const name of ['happy', 'sad', 'surprised', 'relaxed', 'angry'])
          for (const bind of manager.getExpression(name)?.binds ?? [])
            for (const mesh of bind.primitives ?? []) meshes.add(mesh);
        const probes = [...meshes].map((mesh) => {
          const geometry = mesh.geometry;
          const base = geometry.getAttribute('position');
          let mouthTop = -Infinity;
          for (const name of ['aa', 'ih', 'ee', 'oh', 'ou'])
            for (const bind of manager.getExpression(name)?.binds ?? []) {
              if (!bind.primitives?.includes(mesh)) continue;
              const morph = geometry.morphAttributes.position[bind.index];
              for (let vertex = 0; vertex < base.count; vertex++) {
                const delta = ['X', 'Y', 'Z'].map(
                  (axis) =>
                    morph[`get${axis}`](vertex) -
                    (geometry.morphTargetsRelative ? 0 : base[`get${axis}`](vertex)),
                );
                if (delta.reduce((sum, value) => sum + value * value, 0) > 1e-12)
                  mouthTop = Math.max(mouthTop, base.getY(vertex));
              }
            }
          const blinkIndices = new Set<number>();
          for (const name of ['blink', 'blinkLeft', 'blinkRight'])
            for (const bind of manager.getExpression(name)?.binds ?? [])
              if (bind.primitives?.includes(mesh)) blinkIndices.add(bind.index);
          return { mesh, base, mouthTop, blinkIndices };
        });
        (window as any).measureFace = () => {
          let lowerFace = 0;
          let upperFace = 0;
          for (const { mesh, base, mouthTop, blinkIndices } of probes) {
            const morphs = mesh.geometry.morphAttributes.position;
            for (let vertex = 0; vertex < base.count; vertex++) {
              const delta = [0, 0, 0];
              for (let index = 0; index < morphs.length; index++) {
                // These models' blink binds also move cheeks. Isolate mouth
                // and emotion deformation rather than measuring that blink.
                if (blinkIndices.has(index)) continue;
                const weight = mesh.morphTargetInfluences[index] ?? 0;
                if (Math.abs(weight) < 1e-7) continue;
                for (const [component, axis] of ['X', 'Y', 'Z'].entries())
                  delta[component] +=
                    weight *
                    (morphs[index][`get${axis}`](vertex) -
                      (mesh.geometry.morphTargetsRelative ? 0 : base[`get${axis}`](vertex)));
              }
              const displacement = Math.hypot(...delta);
              if (base.getY(vertex) <= mouthTop + 1e-4)
                lowerFace = Math.max(lowerFace, displacement);
              else upperFace = Math.max(upperFace, displacement);
            }
          }
          return { lowerFace, upperFace };
        };
        const rest = {
          left: rotation('leftUpperArm'),
          right: rotation('rightUpperArm'),
          root: renderer.vrm.scene.position.toArray(),
        };
        renderer.beginPhrase(
          { emotion: 'happy', gestures: [{ name: 'open_hand', strength: 0.8 }] },
          3,
        );
        renderer.setSpeaking(true);
        renderer.setMouthOpening(0.6);
        renderer.setPlaybackTime(0.9);
        await wait(800);
        const talking = {
          left: rotation('leftUpperArm'),
          right: rotation('rightUpperArm'),
          head: rotation('head'),
          smile: smile(),
          root: renderer.vrm.scene.position.toArray(),
        };
        renderer.beginPhrase({ emotion: 'happy', gestures: [{ name: 'shrug', strength: 0.8 }] }, 3);
        renderer.setPlaybackTime(0.9);
        await wait(500);
        const leftGesture = rotation('leftUpperArm');
        // Keep the live instance for a visual screenshot before settling it.
        (window as any).checkedAvatar = renderer;
        return { rest, talking, leftGesture };
      },
      { url },
    );
    assert.ok(
      result.talking.right.some(
        (value: number, i: number) => Math.abs(value - result.rest.right[i]) > 0.05,
      ),
    );
    assert.ok(
      result.leftGesture.some(
        (value: number, i: number) => Math.abs(value - result.rest.left[i]) > 0.05,
      ),
    );
    assert.ok(result.talking.smile > 0.1);
    assert.deepEqual(result.talking.root, result.rest.root);
    await page.screenshot({ path: path.join(qa, `gestures-${id}.png`) });
    for (const name of [
      'tsundere_turn',
      'hands_on_hips',
      'raise_hand',
      'crossed_arms',
      'hand_on_chin',
      'dramatic_point',
      'dramatic_lean',
    ]) {
      const pose = await page.evaluate(async (name) => {
        const renderer = (window as any).checkedAvatar;
        const bone = (name: string) => renderer.vrm.humanoid.getNormalizedBoneNode(name);
        const feet = ['leftFoot', 'rightFoot'].map((name) =>
          bone(name).getWorldPosition(bone(name).position.clone()).toArray(),
        );
        const root = renderer.vrm.scene.position.toArray();
        const head = bone('head');
        const headRest = head.getWorldQuaternion(head.quaternion.clone());
        const cameraRest = renderer.camera.position.toArray();
        const lookAt = renderer.vrm.lookAt;
        const rawEyes = ['leftEye', 'rightEye'].map((name) =>
          renderer.vrm.humanoid.getRawBoneNode(name),
        );
        const eyeRest = rawEyes.map((eye) => eye?.quaternion.clone());
        const gazeRest = lookAt
          ? {
              yaw: lookAt.yaw,
              pitch: lookAt.pitch,
              autoUpdate: lookAt.autoUpdate,
              target: lookAt.target,
              ranges: ['rangeMapHorizontalInner', 'rangeMapHorizontalOuter'].map((name) => ({
                inputMaxValue: lookAt.applier[name].inputMaxValue,
                outputScale: lookAt.applier[name].outputScale,
              })),
            }
          : undefined;
        (window as any).poseGazeRest = gazeRest;
        renderer.setSpeaking(false);
        renderer.setMouthOpening(0);
        renderer.previewPose(name, 1, 4);
        await new Promise((resolve) => setTimeout(resolve, 950));
        const currentFeet = ['leftFoot', 'rightFoot'].map((name) =>
          bone(name).getWorldPosition(bone(name).position.clone()).toArray(),
        );
        const projected = ['leftFoot', 'rightFoot', 'rightHand', 'head'].map((name) =>
          bone(name)
            .getWorldPosition(bone(name).position.clone())
            .project(renderer.camera)
            .toArray(),
        );
        const mouthClosed = renderer.vrm.expressionManager.getValue('aa');
        renderer.setMouthOpening(0.6);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const mouthOpen = renderer.vrm.expressionManager.getValue('aa');
        renderer.setMouthOpening(0);
        return {
          feet,
          currentFeet,
          root,
          currentRoot: renderer.vrm.scene.position.toArray(),
          projected,
          mouthClosed,
          mouthOpen,
          left: bone('leftUpperArm').rotation.toArray().slice(0, 3),
          right: bone('rightUpperArm').rotation.toArray().slice(0, 3),
          camera: renderer.camera.position.toArray(),
          cameraRest,
          headTurn: headRest.angleTo(head.getWorldQuaternion(head.quaternion.clone())),
          palms: ['left', 'right'].map((side) => {
            const chest = bone('chest') ?? bone('spine');
            const rotation = chest.getWorldQuaternion(chest.quaternion.clone());
            const hand = bone(`${side}Hand`);
            const wrist = hand.getWorldQuaternion(hand.quaternion.clone());
            const palm = hand.position.clone().set(0, -1, 0).applyQuaternion(wrist);
            const thumb = hand.position.clone().set(0, 0, 1).applyQuaternion(wrist);
            const inward = hand.position.clone().set(0, 0, -1).applyQuaternion(rotation);
            const up = hand.position.clone().set(0, 1, 0).applyQuaternion(rotation);
            return { inward: palm.dot(inward), thumbUp: thumb.dot(up) };
          }),
          gaze: lookAt
            ? {
                yaw: lookAt.yaw,
                pitch: lookAt.pitch,
                autoUpdate: lookAt.autoUpdate,
                eyeDegrees: rawEyes.map((eye, index) =>
                  eye ? (eyeRest[index].angleTo(eye.quaternion) * 180) / Math.PI : null,
                ),
                // Check applied morph weights, not just the look-at request.
                eyeMorph: Math.max(
                  ...['lookLeft', 'lookRight'].flatMap(
                    (name) =>
                      renderer.vrm.expressionManager
                        .getExpression(name)
                        ?.binds.flatMap((bind) =>
                          (bind.primitives ?? []).map(
                            (primitive) => primitive.morphTargetInfluences?.[bind.index] ?? 0,
                          ),
                        ) ?? [],
                  ),
                  0,
                ),
              }
            : undefined,
        };
      }, name);
      assert.deepEqual(pose.currentRoot, pose.root, `${id} ${name} must not move the scene root`);
      assert.ok(pose.mouthClosed < 0.001, `${id} ${name} must not open the mouth`);
      assert.ok(pose.mouthOpen > 0.4, `${id} ${name} must preserve mouth animation`);
      if (name === 'crossed_arms' || name === 'tsundere_turn')
        assert.ok(
          pose.palms.every((palm) => palm.inward > 0.99 && palm.thumbUp > 0.99),
          `${id} ${name} palms face the chest, thumbs up: ${JSON.stringify(pose.palms)}`,
        );
      assert.ok(
        pose.left.some(
          (value: number, i: number) => Math.abs(value - result.rest.left[i]) > 0.05,
        ) ||
          pose.right.some(
            (value: number, i: number) => Math.abs(value - result.rest.right[i]) > 0.05,
          ),
      );
      if (name === 'tsundere_turn') {
        assert.ok(
          pose.headTurn > 0.5 && pose.headTurn < 0.9,
          `${id} three-quarter head turn: ${pose.headTurn}`,
        );
        assert.deepEqual(
          pose.camera,
          pose.cameraRest,
          `${id} tsundere turn keeps conversation framing`,
        );
        assert.ok(
          pose.gaze && Math.abs(pose.gaze.yaw) > 20,
          `${id} glances back toward the viewer`,
        );
        assert.equal(pose.gaze?.autoUpdate, false);
        if (id === 'mira') {
          assert.ok(
            pose.gaze.eyeDegrees.every((angle: number) => angle > 10 && angle < 13),
            `${id} actual eye rotations: ${JSON.stringify(pose.gaze.eyeDegrees)}`,
          );
        } else {
          assert.ok(
            pose.gaze.eyeMorph > 0.9,
            `${id} actual eye morph weight: ${pose.gaze.eyeMorph}`,
          );
        }
      }
      if (name === 'dramatic_lean' || name === 'tsundere_turn') {
        for (let side = 0; side < 2; side++)
          assert.ok(
            Math.hypot(
              ...pose.currentFeet[side].map(
                (value: number, i: number) => value - pose.feet[side][i],
              ),
            ) < 0.005,
            `${id} ${name} must keep both feet planted`,
          );
      }
      if (['raise_hand', 'dramatic_point', 'dramatic_lean'].includes(name))
        assert.ok(
          pose.projected.every(
            (point: number[]) => Math.abs(point[0]) < 1 && Math.abs(point[1]) < 1,
          ),
          `${id} ${name} full body should fit: ${JSON.stringify(pose.projected)}`,
        );
      await page.screenshot({ path: path.join(qa, `pose-${id}-${name}.png`) });
      const released = await page.evaluate(async () => {
        const renderer = (window as any).checkedAvatar;
        renderer.stopPose();
        await new Promise((resolve) => setTimeout(resolve, 750));
        const lookAt = renderer.vrm.lookAt;
        const rest = (window as any).poseGazeRest;
        return (
          !rest ||
          (lookAt.target === rest.target &&
            lookAt.autoUpdate === rest.autoUpdate &&
            Math.abs(lookAt.yaw - rest.yaw) < 1e-5 &&
            Math.abs(lookAt.pitch - rest.pitch) < 1e-5 &&
            ['rangeMapHorizontalInner', 'rangeMapHorizontalOuter'].every(
              (name, index) =>
                lookAt.applier[name].inputMaxValue === rest.ranges[index].inputMaxValue &&
                lookAt.applier[name].outputScale === rest.ranges[index].outputScale,
            ))
        );
      });
      assert.ok(released, `${id} ${name} restores previous gaze`);
    }
    const hop = await page.evaluate(async () => {
      const renderer = (window as any).checkedAvatar;
      const bone = (name: string) => renderer.vrm.humanoid.getNormalizedBoneNode(name);
      const foot = bone('leftFoot');
      const position = () => foot.getWorldPosition(foot.position.clone()).y;
      renderer.stopPose();
      renderer.setSpeaking(false);
      renderer.setMouthOpening(0);
      // Let camera easing from the previous full-body preset settle first.
      await new Promise((resolve) => setTimeout(resolve, 1600));
      const ground = position();
      const root = renderer.vrm.scene.position.toArray();
      const camera = renderer.camera.position.clone();
      const fingerNames = (['left', 'right'] as const).flatMap((side) =>
        ['Index', 'Middle', 'Ring', 'Little'].map((finger) => ({
          side,
          name: `${side}${finger}Distal`,
        })),
      );
      const reach = ({ side, name }: { side: string; name: string }) => {
        const hand = renderer.vrm.humanoid.getRawBoneNode(`${side}Hand`);
        const finger = renderer.vrm.humanoid.getRawBoneNode(name);
        return hand.worldToLocal(finger.getWorldPosition(hand.position.clone())).length();
      };
      const openReach = fingerNames.map(reach);
      const fingerRest = Object.fromEntries(
        Object.keys(renderer.vrm.humanoid.normalizedHumanBones)
          .filter((name) => /Thumb|Index|Middle|Ring|Little/.test(name))
          .map((name) => [name, bone(name).quaternion.clone()]),
      );
      renderer.previewPose('angry_hop', 1, 3);
      const samples: number[] = [];
      let angry = 0;
      let mouth = 0;
      let cameraShift = 0;
      let closedReach: number[] = [];
      let thumbCurl: number[] = [];
      for (let index = 0; index < 80; index++) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        samples.push(position() - ground);
        angry = Math.max(angry, renderer.vrm.expressionManager.getValue('talk-angry'));
        mouth = Math.max(mouth, renderer.vrm.expressionManager.getValue('aa'));
        cameraShift = Math.max(cameraShift, renderer.camera.position.distanceTo(camera));
        if (index === 20) {
          closedReach = fingerNames.map(reach);
          thumbCurl = ['leftThumbMetacarpal', 'rightThumbMetacarpal'].map((name) =>
            bone(name).quaternion.angleTo(fingerRest[name]),
          );
        }
      }
      renderer.stopPose();
      await new Promise((resolve) => setTimeout(resolve, 700));
      return {
        maxLift: Math.max(...samples),
        groundError: position() - ground,
        angry,
        mouth,
        root,
        rootAfter: renderer.vrm.scene.position.toArray(),
        cameraShift,
        fingerReachRatios: closedReach.map((reach, index) => reach / openReach[index]),
        thumbCurl,
        fingerRestError: Math.max(
          ...Object.entries(fingerRest).map(([name, rest]) => bone(name).quaternion.angleTo(rest)),
        ),
      };
    });
    assert.ok(
      hop.maxLift > 0.02 && hop.maxLift < 0.12,
      `${id} visible bounded hop: ${JSON.stringify(hop)}`,
    );
    assert.ok(Math.abs(hop.groundError) < 0.005, `${id} returns to standing height`);
    assert.ok(hop.angry > 0.5);
    assert.ok(hop.mouth < 0.001);
    assert.deepEqual(hop.rootAfter, hop.root);
    assert.ok(hop.cameraShift < 0.001, `${id} angry hop keeps normal framing`);
    assert.ok(
      hop.fingerReachRatios.every((ratio) => ratio < 0.85),
      `${id} all fingers curl toward the palm: ${JSON.stringify(hop.fingerReachRatios)}`,
    );
    assert.ok(
      hop.thumbCurl.every((angle) => angle > 0.5),
      `${id} both thumbs fold in`,
    );
    assert.ok(hop.fingerRestError < 0.001, `${id} hands relax after Stop`);
    await page.evaluate(() => (window as any).checkedAvatar.setSpeaking(true));
    for (const emotion of [
      'happy',
      'sad',
      'surprised',
      'thoughtful',
      'angry',
      'neutral',
    ] as const) {
      const face = await page.evaluate(async (emotion) => {
        const renderer = (window as any).checkedAvatar;
        renderer.beginPhrase({ emotion, gestures: [] }, 6);
        renderer.setMouthOpening(0.6);
        renderer.setPlaybackTime(3);
        // A surprised face must remain visible beyond the old 2.2-second fade.
        await new Promise((resolve) => setTimeout(resolve, emotion === 'surprised' ? 2800 : 900));
        const manager = renderer.vrm.expressionManager;
        const morph = (name: string) => {
          const bind =
            manager.getExpression(`talk-${name}`)?.binds.find((bind: any) => bind.primitives) ??
            manager.getExpression(name)?.binds.find((bind: any) => bind.primitives);
          return bind ? bind.primitives[0].morphTargetInfluences[bind.index] : 0;
        };
        return {
          happy: morph('happy'),
          sad: morph('sad'),
          surprised: morph('surprised'),
          relaxed: morph('relaxed'),
          angry: morph('angry'),
          mouth: morph('aa'),
          deformation: (window as any).measureFace(),
          texture: manager.getValue(
            `talk-texture-${emotion === 'thoughtful' ? 'relaxed' : emotion}`,
          ),
          textureWeights: ['happy', 'sad', 'surprised', 'relaxed', 'angry'].map(
            (name) => manager.getValue(`talk-texture-${name}`) ?? 0,
          ),
        };
      }, emotion);
      const preset = emotion === 'thoughtful' ? 'relaxed' : emotion;
      if (preset !== 'neutral') {
        assert.ok(
          face[preset] > 0.35,
          `${id} ${emotion} should visibly deform its face: ${JSON.stringify(face)}`,
        );
        if (id === 'seed-san')
          assert.equal(face.texture, 1, `${emotion} must select the matching facial texture`);
      } else {
        assert.ok(
          ['happy', 'sad', 'surprised', 'relaxed', 'angry'].every(
            (name) => (face[name as keyof typeof face] as number) < 0.03,
          ),
        );
        assert.ok(face.textureWeights.every((weight: number) => weight === 0));
      }
      assert.ok(face.mouth > 0.4, `${id} ${emotion} must preserve speech mouth motion`);
      assert.ok(face.deformation.lowerFace > 0.001, `${id} audio must actually open the mouth`);
      await page.screenshot({ path: path.join(qa, `emotion-${id}-${emotion}.png`) });
      const closed = await page.evaluate(async () => {
        const renderer = (window as any).checkedAvatar;
        renderer.setMouthOpening(0);
        const renderedMouthWeight = () => {
          const manager = renderer.vrm.expressionManager;
          const weights = ['aa', 'ih', 'ee', 'oh', 'ou'].flatMap((name) =>
            (manager.getExpression(name)?.binds ?? []).flatMap((bind: any) =>
              (bind.primitives ?? []).map((mesh: any) =>
                Math.abs(mesh.morphTargetInfluences[bind.index] ?? 0),
              ),
            ),
          );
          return Math.max(0, ...weights);
        };
        // Wait for rendered animation frames, not a wall-clock delay that can
        // expire while another Chrome check has backgrounded this page.
        await new Promise<void>((resolve) => {
          const started = performance.now();
          const settled = () => {
            if (renderedMouthWeight() < 1e-5 || performance.now() - started > 5000) resolve();
            else requestAnimationFrame(settled);
          };
          requestAnimationFrame(settled);
        });
        const amplitude = (window as any).measureFace();
        renderer.setMouth('X');
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { amplitude, phonetic: (window as any).measureFace() };
      });
      assert.ok(
        closed.amplitude.lowerFace < 1e-5,
        `${id} ${emotion} holds the mouth open during silence: ${JSON.stringify(closed)}`,
      );
      assert.ok(
        closed.phonetic.lowerFace < 1e-5,
        `${id} ${emotion} must close for phonetic rest too: ${JSON.stringify(closed)}`,
      );
      if (emotion !== 'neutral')
        assert.ok(
          closed.amplitude.upperFace > 1e-4,
          `${id} ${emotion} should retain eye/brow expression with closed lips`,
        );
      await page.screenshot({ path: path.join(qa, `emotion-closed-${id}-${emotion}.png`) });
    }
    const settled = await page.evaluate(async () => {
      const renderer = (window as any).checkedAvatar;
      renderer.beginPhrase({ emotion: 'neutral', gestures: [{ name: 'nod', strength: 0.8 }] }, 3);
      renderer.setPlaybackTime(0.6);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const heldHead = renderer.vrm.humanoid.getNormalizedBoneNode('head').rotation.x;
      await new Promise((resolve) => setTimeout(resolve, 200));
      const stillHead = renderer.vrm.humanoid.getNormalizedBoneNode('head').rotation.x;
      renderer.setPlaybackTime(2);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const finishedHead = renderer.vrm.humanoid.getNormalizedBoneNode('head').rotation.x;
      renderer.setSpeaking(false);
      renderer.setMouth('X');
      await new Promise((resolve) => setTimeout(resolve, 2200));
      const result = {
        left: renderer.vrm.humanoid
          .getNormalizedBoneNode('leftUpperArm')
          .rotation.toArray()
          .slice(0, 3),
        right: renderer.vrm.humanoid
          .getNormalizedBoneNode('rightUpperArm')
          .rotation.toArray()
          .slice(0, 3),
        smile: renderer.vrm.expressionManager.getValue('talk-happy'),
        heldHead,
        stillHead,
        finishedHead,
      };
      renderer.dispose();
      return result;
    });
    for (const side of ['left', 'right'] as const)
      assert.ok(
        settled[side].every(
          (value: number, i: number) => Math.abs(value - result.rest[side][i]) < 0.005,
        ),
      );
    assert.ok(settled.smile < 0.005);
    assert.ok(Math.abs(settled.heldHead) > 0.02);
    assert.ok(Math.abs(settled.heldHead - settled.stillHead) < 0.005);
    assert.ok(Math.abs(settled.finishedHead) < 0.005);
    console.log(
      JSON.stringify({
        persona: id,
        passed: true,
        checks: [
          'tagged arm gestures',
          'smile',
          'root stays fixed',
          'restored resting pose',
          'gesture follows audio time',
          'happy/sad/surprised/thoughtful/angry/neutral faces',
          'sustained surprise and speech mouth',
          'binary facial texture selection',
          'mouth closes under every active emotion',
          'eyes/brows remain expressive during silence',
          'seven static pose presets and three bounded angry hops without speech',
          'closed fists with folded thumbs, normal hop framing and relaxed hands after Stop',
          'three-quarter tsundere turn and restored camera gaze',
          'poses preserve independent mouth animation',
          'dramatic pose camera framing and planted feet',
        ],
      }),
    );
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
