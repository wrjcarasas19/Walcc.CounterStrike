import {
  checkSetting,
  defaultSettings,
  parseSettings,
  serializeSettings,
  SETTING_KEYS,
  type SettingKey,
  type Settings,
} from './schema';

// The player's settings, kept in localStorage like the name (player.ts).
// Every value is checked on the way in, so readers can trust getSettings().

const STORAGE_KEY = 'player-settings';

type Listener = (settings: Readonly<Settings>, changed: SettingKey[]) => void;

const listeners = new Set<Listener>();
let current: Settings = load();

function load(): Settings {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {}
  return parseSettings(saved);
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, serializeSettings(current));
  } catch {
    // Private mode or storage full: settings still apply until reload.
  }
}

function update(next: Settings): void {
  const changed = SETTING_KEYS.filter((key) => next[key] !== current[key]);
  if (changed.length === 0) return;
  current = next;
  save();
  for (const listener of listeners) listener(current, changed);
}

export function getSettings(): Readonly<Settings> {
  return current;
}

/**
 * Changes one setting if value is valid for it; returns false (and changes
 * nothing) otherwise.
 */
export function setSetting<K extends SettingKey>(
  key: K,
  value: Settings[K]
): boolean {
  const checked = checkSetting(key, value);
  if (checked === undefined) return false;
  update({ ...current, [key]: checked });
  return true;
}

export function resetSettings(): void {
  update(defaultSettings());
}

/**
 * Calls listener after settings change, with the keys that changed. Returns
 * a function that removes it.
 */
export function onSettingsChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
