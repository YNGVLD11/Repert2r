import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('public', { recursive: true });
copyFileSync(
  'node_modules/@soundtouchjs/audio-worklet/.dist/soundtouch-processor.js',
  'public/soundtouch-processor.js',
);
