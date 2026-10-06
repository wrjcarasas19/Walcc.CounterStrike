import { defineConfig } from 'vite';
// Throw if a game mode preset, a settings default or a radio wheel item is
// invalid, so the build fails.
import './src/client/src/admin/presets';
import './src/client/src/settings/schema';
import './src/client/src/wheel/items';

export default defineConfig({
  root: './src/client',
});
