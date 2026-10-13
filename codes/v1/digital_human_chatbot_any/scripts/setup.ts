import { mkdir, readFile, writeFile, cp, chmod, access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));

const source = path.resolve(root, '../../../docs/v1/personas');

const publicRoot = path.join(root, 'frontend/public');

const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));

for (const file of manifest.files) {
  const bytes = await readFile(path.join(source, file.path));
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256)
    throw new Error(`Persona checksum mismatch: ${file.path}`);
}

await mkdir(path.join(publicRoot, 'personas'), { recursive: true });

for (const [id, folder] of [
  ['constraint-twist', 'vrm/constraint-twist'],
  ['seed-san', 'vrm/seed-san'],
  ['haru', 'live2d/haru'],
  ['ren', 'live2d/ren'],
]) {
  await cp(path.join(source, 'models', folder), path.join(publicRoot, 'personas', id), {
    recursive: true,
    filter: (p) => !p.endsWith('.DS_Store'),
  });
}

await cp(path.join(source, 'licenses'), path.join(publicRoot, 'personas/licenses'), {
  recursive: true,
});

console.log('Staged four verified persona packages and notices.');

const vendor = path.join(publicRoot, 'vendor');

await mkdir(vendor, { recursive: true });

const coreUrl = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';

const coreFile = path.join(vendor, 'live2dcubismcore.min.js');

try {
  await access(coreFile);
} catch {
  const response = await fetch(coreUrl, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Cubism Core download: HTTP ${response.status}`);
  await writeFile(coreFile, Buffer.from(await response.arrayBuffer()));
}

await writeFile(
  path.join(vendor, 'README.txt'),
  `Live2D Cubism Core, copyright Live2D Inc.\nSource: ${coreUrl}\nProprietary Software License: https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html\nSDK release terms: https://www.live2d.com/en/sdk/license/\nDownloaded for this local application; publication requires compliance with these terms.\nSHA256: ${createHash(
    'sha256',
  )
    .update(await readFile(coreFile))
    .digest('hex')}\n`,
);

if (process.platform === 'darwin') {
  const tools = path.join(root, 'tools');
  const executable = path.join(tools, 'rhubarb/rhubarb');
  try {
    await access(executable);
  } catch {
    await mkdir(tools, { recursive: true });
    const url =
      'https://github.com/DanielSWolf/rhubarb-lip-sync/releases/download/v1.14.0/Rhubarb-Lip-Sync-1.14.0-macOS.zip';
    console.log('Downloading Rhubarb 1.14.0 for macOS…');
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Rhubarb download: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    await writeFile(path.join(tools, 'rhubarb.zip'), archive);
    await promisify(execFile)('/usr/bin/unzip', [
      '-q',
      '-o',
      path.join(tools, 'rhubarb.zip'),
      '-d',
      path.join(tools, 'unpacked'),
    ]);
    const folder = (await readdir(path.join(tools, 'unpacked'))).find((n) =>
      n.startsWith('Rhubarb-Lip-Sync'),
    );
    if (!folder) throw new Error('Unexpected Rhubarb archive layout');
    await cp(path.join(tools, 'unpacked', folder), path.join(tools, 'rhubarb'), {
      recursive: true,
    });
    await chmod(executable, 0o755);
    await writeFile(
      path.join(tools, 'SOURCE.json'),
      JSON.stringify(
        { url, version: '1.14.0', sha256: createHash('sha256').update(archive).digest('hex') },
        null,
        2,
      ),
    );
  }
  const version = await promisify(execFile)(executable, ['--version']);
  console.log(version.stdout.trim());
} else {
  console.log('Install Rhubarb for this OS and set RHUBARB_BIN to its executable.');
}

console.log('Offline avatar assets and Live2D Core ready.');
