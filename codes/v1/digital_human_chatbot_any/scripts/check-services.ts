import { readConfig } from '../backend/src/config.js';
import { serviceHealth } from '../backend/src/app.js';
import { rhubarbAvailable } from '../backend/src/services/lipsync.js';

const config = readConfig();

for (const [name, url] of [
  ['ASR', config.ASR_BASE_URL],
  ['TTS', config.TTS_BASE_URL],
])
  console.log(name, url, await serviceHealth(url));

console.log(
  'Lip sync',
  config.LIPSYNC_PROVIDER === 'amplitude'
    ? 'ready (browser amplitude)'
    : (await rhubarbAvailable(config))
      ? 'Rhubarb ready'
      : 'Rhubarb unavailable; run npm run setup',
);

console.log(
  'LLM',
  config.LLM_MODEL_NAME ? 'configured (credentials hidden)' : 'missing LLM_MODEL_NAME',
);
