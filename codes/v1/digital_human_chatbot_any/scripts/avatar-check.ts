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

const browser = await chromium.launch({ channel: 'chrome', headless: true });

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
        const happyBind = renderer.vrm.expressionManager
          .getExpression('happy')
          .binds.find((bind: any) => bind.primitives);
        const smile = () => happyBind.primitives[0].morphTargetInfluences[happyBind.index];
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
    for (const emotion of ['happy', 'sad', 'surprised', 'thoughtful', 'neutral'] as const) {
      const face = await page.evaluate(async (emotion) => {
        const renderer = (window as any).checkedAvatar;
        renderer.beginPhrase({ emotion, gestures: [] }, 6);
        renderer.setMouthOpening(0.6);
        renderer.setPlaybackTime(3);
        // A surprised face must remain visible beyond the old 2.2-second fade.
        await new Promise((resolve) => setTimeout(resolve, emotion === 'surprised' ? 2800 : 900));
        const manager = renderer.vrm.expressionManager;
        const morph = (name: string) => {
          const bind = manager.getExpression(name)?.binds.find((bind: any) => bind.primitives);
          return bind ? bind.primitives[0].morphTargetInfluences[bind.index] : 0;
        };
        return {
          happy: morph('happy'),
          sad: morph('sad'),
          surprised: morph('surprised'),
          relaxed: morph('relaxed'),
          mouth: morph('aa'),
          texture: manager.getValue(
            `talk-texture-${emotion === 'thoughtful' ? 'relaxed' : emotion}`,
          ),
          textureWeights: ['happy', 'sad', 'surprised', 'relaxed'].map(
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
          ['happy', 'sad', 'surprised', 'relaxed'].every(
            (name) => (face[name as keyof typeof face] as number) < 0.03,
          ),
        );
        assert.ok(face.textureWeights.every((weight: number) => weight === 0));
      }
      assert.ok(face.mouth > 0.4, `${id} ${emotion} must preserve speech mouth motion`);
      await page.screenshot({ path: path.join(qa, `emotion-${id}-${emotion}.png`) });
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
      const bind = renderer.vrm.expressionManager
        .getExpression('happy')
        .binds.find((bind: any) => bind.primitives);
      const result = {
        left: renderer.vrm.humanoid
          .getNormalizedBoneNode('leftUpperArm')
          .rotation.toArray()
          .slice(0, 3),
        right: renderer.vrm.humanoid
          .getNormalizedBoneNode('rightUpperArm')
          .rotation.toArray()
          .slice(0, 3),
        smile: bind.primitives[0].morphTargetInfluences[bind.index],
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
          'happy/sad/surprised/thoughtful/neutral faces',
          'sustained surprise and speech mouth',
          'binary facial texture selection',
        ],
      }),
    );
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
