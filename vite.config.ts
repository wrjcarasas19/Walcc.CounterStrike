import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
// Throw if a game mode preset, a settings default or a radio wheel item is
// invalid, so the build fails.
import './src/client/src/admin/presets';
import './src/client/src/settings/schema';
import './src/client/src/wheel/items';

// The installed cs16-client release, so the page knows which bridge events
// the game client sends (e.g. `mode` from 0.0.10, see gamemode.ts).
const cs16Client = JSON.parse(
  readFileSync(
    new URL('./node_modules/cs16-client/package.json', import.meta.url),
    'utf8'
  )
) as { version: string };

export default defineConfig({
  root: './src/client',
  define: {
    __CS16_CLIENT_VERSION__: JSON.stringify(cs16Client.version),
  },
});
