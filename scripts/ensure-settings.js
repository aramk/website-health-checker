// npm `prestart`: create settings.json from the example when it's missing,
// so a fresh clone works on the first `npm start`.
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = process.env.SETTINGS_PATH || join(rootDir, 'settings.json');
const example = join(rootDir, 'settings-example.json');

if (existsSync(dest)) {
  console.log(`[settings] using ${dest}`);
} else if (existsSync(example)) {
  copyFileSync(example, dest);
  console.log(`[settings] created ${dest} from settings-example.json — edit it to configure your sites`);
} else {
  console.error('[settings] no settings.json or settings-example.json found; using built-in defaults');
}
