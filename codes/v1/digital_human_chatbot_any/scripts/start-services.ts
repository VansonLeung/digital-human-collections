import { readConfig } from '../backend/src/config.js';
import { SpeechServiceLauncher } from './services/launcher.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    "Usage: npm run start:services [-- --dry-run]\nStarts ASR and TTS in the foreground. Ctrl+C stops only workers launched here.\nPYTHON_BIN overrides each service's PYTHON_BASE. SERVICE_START_TIMEOUT_SECONDS defaults to 300.",
  );
} else if (args.some((arg) => arg !== '--dry-run')) {
  console.error('Unknown option. Use --help or --dry-run.');
  process.exitCode = 1;
} else {
  let interrupted = false;
  let failureReported = false;
  const launcher = new SpeechServiceLauncher(readConfig(), {}, (error) => {
    failureReported = true;
    console.error(error.message);
    process.exitCode = 1;
  });
  const stop = () => {
    interrupted = true;
    void launcher.stop();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await launcher.start(args.includes('--dry-run'));
  } catch (error) {
    if (!interrupted && !failureReported) {
      console.error((error as Error).message);
      process.exitCode = 1;
    }
  }
}
