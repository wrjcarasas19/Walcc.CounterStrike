// Player settings: what can be set, defaults, checks, and the engine
// commands built from them. No DOM here, so it can be tested with node.
//
// To add a setting, add an entry to SETTINGS (the panel builds its control
// from it and the store validates it), then read it with getSettings() /
// onSettingsChange() from ./store, or map it to a cvar in CVARS below.

export type SettingGroup =
  'Mouse' | 'Crosshair' | 'Sound' | 'HUD' | 'Voice' | 'Keys';

type Common = { group: SettingGroup; label: string; hint?: string };

export type NumberSetting = Common & {
  kind: 'number';
  min: number;
  max: number;
  /** Values are min + k * step; the decimals of step are kept. */
  step: number;
  unit: '' | '%';
  default: number;
};

export type ChoiceSetting<V extends string = string> = Common & {
  kind: 'choice';
  options: readonly { value: V; label: string }[];
  default: V;
};

export type ToggleSetting = Common & { kind: 'toggle'; default: boolean };

/**
 * A device picked from a list the page fills in at run time (the
 * microphones, ../voice.ts): the value is the device's id, '' for the
 * browser's default, which is listed as defaultLabel.
 */
export type DeviceSetting = Common & {
  kind: 'device';
  defaultLabel: string;
  default: '';
};

export type SettingDef =
  NumberSetting | ChoiceSetting | ToggleSetting | DeviceSetting;

function numberSetting(def: Omit<NumberSetting, 'kind'>): NumberSetting {
  return { kind: 'number', ...def };
}

function choiceSetting<V extends string>(
  def: Omit<ChoiceSetting<V>, 'kind' | 'default'> & { default: NoInfer<V> }
): ChoiceSetting<V> {
  return { kind: 'choice', ...def };
}

function toggleSetting(def: Omit<ToggleSetting, 'kind'>): ToggleSetting {
  return { kind: 'toggle', ...def };
}

function deviceSetting(def: Omit<DeviceSetting, 'kind'>): DeviceSetting {
  return { kind: 'device', ...def };
}

/** Device ids are opaque strings (hex in Chrome, base64 in Firefox). */
const DEVICE_ID_PATTERN = /^[\x21-\x7e]{0,256}$/;

// The colours of the stock `adjust_crosshair` command (cs16-client ammo.cpp).
const CROSSHAIR_COLORS = {
  green: '50 250 50',
  red: '250 50 50',
  blue: '50 50 250',
  yellow: '250 250 50',
  cyan: '50 250 250',
} as const;

const VOICE_KEY_OPTIONS = [
  { value: 'k', label: 'K' },
  { value: 'j', label: 'J' },
  { value: 'l', label: 'L' },
  { value: 'p', label: 'P' },
  { value: 'off', label: 'Off' },
] as const;

export const SETTINGS = {
  sensitivity: numberSetting({
    group: 'Mouse',
    label: 'Mouse sensitivity',
    min: 0.1,
    max: 20,
    step: 0.1,
    unit: '',
    default: 3,
  }),
  crosshairColor: choiceSetting({
    group: 'Crosshair',
    label: 'Colour',
    options: [
      { value: 'green', label: 'Green' },
      { value: 'red', label: 'Red' },
      { value: 'blue', label: 'Blue' },
      { value: 'yellow', label: 'Yellow' },
      { value: 'cyan', label: 'Cyan' },
    ],
    default: 'green',
  }),
  crosshairSize: choiceSetting({
    group: 'Crosshair',
    label: 'Size',
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'small', label: 'Small' },
      { value: 'medium', label: 'Medium' },
      { value: 'large', label: 'Large' },
    ],
    default: 'auto',
  }),
  crosshairTranslucent: toggleSetting({
    group: 'Crosshair',
    label: 'Translucent',
    default: true,
  }),
  crosshairDynamic: toggleSetting({
    group: 'Crosshair',
    label: 'Dynamic',
    hint: 'Spreads while moving and shooting',
    default: true,
  }),
  volume: numberSetting({
    group: 'Sound',
    label: 'Volume',
    min: 0,
    max: 100,
    step: 5,
    unit: '%',
    default: 70,
  }),
  // Announcer sounds (../announcer.ts: first blood, headshot, multi-kills...);
  // 0 turns them off, and then they aren't even downloaded.
  announcerVolume: numberSetting({
    group: 'Sound',
    label: 'Announcer volume',
    min: 0,
    max: 100,
    step: 5,
    unit: '%',
    default: 70,
  }),
  announcerHeadshots: toggleSetting({
    group: 'Sound',
    label: 'Announce headshots',
    hint: 'Can be very frequent',
    default: true,
  }),
  announcerOthers: toggleSetting({
    group: 'Sound',
    label: "Hear other players' first blood",
    default: true,
  }),
  hudScale: numberSetting({
    group: 'HUD',
    label: 'HUD size',
    min: 50,
    max: 150,
    step: 5,
    unit: '%',
    default: 100,
  }),
  hudOpacity: numberSetting({
    group: 'HUD',
    label: 'HUD opacity',
    min: 20,
    max: 100,
    step: 5,
    unit: '%',
    default: 100,
  }),
  killStreakToasts: toggleSetting({
    group: 'HUD',
    label: 'Multi-kill toasts',
    hint: 'Double kill, triple kill...',
    default: true,
  }),
  // "Killed by" card (D.4, killcard.ts).
  killerCard: toggleSetting({
    group: 'HUD',
    label: 'Killer card',
    hint: 'Who killed you and your record against them',
    default: true,
  }),
  // Voice chat (../voice.ts). Off: the microphone is never asked for and
  // nobody is heard.
  voiceEnabled: toggleSetting({
    group: 'Voice',
    label: 'Voice chat',
    hint: 'Hold the push-to-talk keys (Keys below) to talk to your team or to everyone',
    default: true,
  }),
  voiceVolume: numberSetting({
    group: 'Voice',
    label: 'Voice volume',
    min: 0,
    max: 100,
    step: 5,
    unit: '%',
    default: 80,
  }),
  voiceInput: deviceSetting({
    group: 'Voice',
    label: 'Microphone',
    defaultLabel: 'Default microphone',
    default: '',
  }),
  // Hold to show the radio and quick chat wheel (../wheel). Z replaces the
  // stock radio1 menu key (the wheel has the same commands); V is unbound in
  // stock CS 1.6.
  radioWheelKey: choiceSetting({
    group: 'Keys',
    label: 'Radio wheel (hold)',
    options: [
      { value: 'z', label: 'Z (instead of the Z radio menu)' },
      { value: 'v', label: 'V' },
      { value: 'off', label: 'Off (Z opens the radio menu)' },
    ],
    default: 'z',
  }),
  // Hold to talk (../voice.ts). K is `+voicerecord` in stock CS 1.6 (the
  // engine's own voice is off, engine.ts); J, L and P are unbound there.
  voiceKey: choiceSetting({
    group: 'Keys',
    label: 'Push to talk: team (hold)',
    options: VOICE_KEY_OPTIONS,
    default: 'k',
  }),
  // Hold to talk to all players, enemies included (A.7). Never the same
  // key as voiceKey (fixKeyConflicts).
  voiceAllKey: choiceSetting({
    group: 'Keys',
    label: 'Push to talk: all players (hold)',
    options: VOICE_KEY_OPTIONS,
    default: 'l',
  }),
};

export type SettingKey = keyof typeof SETTINGS;

type ValueOf<D> =
  D extends ChoiceSetting<infer V>
    ? V
    : D extends NumberSetting
      ? number
      : D extends ToggleSetting
        ? boolean
        : D extends DeviceSetting
          ? string
          : never;

export type Settings = { [K in SettingKey]: ValueOf<(typeof SETTINGS)[K]> };

export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

function decimals(step: number): number {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** The value as shown in the panel, e.g. "3.0" or "70%". */
export function formatNumber(def: NumberSetting, value: number): string {
  return value.toFixed(decimals(def.step)) + def.unit;
}

/**
 * Returns value if it is valid for the setting (rounded to the step's
 * decimals), or undefined. Used for everything read back from storage and
 * every change from the panel.
 */
export function checkSetting<K extends SettingKey>(
  key: K,
  value: unknown
): Settings[K] | undefined {
  const def: SettingDef = SETTINGS[key];
  switch (def.kind) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      if (value < def.min || value > def.max) return;
      const steps = Math.round((value - def.min) / def.step);
      const snapped = Number(
        (def.min + steps * def.step).toFixed(decimals(def.step))
      );
      if (Math.abs(snapped - value) > 1e-9) return;
      return snapped as Settings[K];
    }
    case 'choice':
      return def.options.some((option) => option.value === value)
        ? (value as Settings[K])
        : undefined;
    case 'toggle':
      return typeof value === 'boolean' ? (value as Settings[K]) : undefined;
    case 'device':
      return typeof value === 'string' && DEVICE_ID_PATTERN.test(value)
        ? (value as Settings[K])
        : undefined;
  }
}

export function defaultSettings(): Settings {
  const settings = {} as Record<SettingKey, unknown>;
  for (const key of SETTING_KEYS) settings[key] = SETTINGS[key].default;
  return settings as Settings;
}

/**
 * Reads settings saved by serializeSettings. Anything missing, unknown or
 * out of range (bad JSON, an older or hand-edited value) gets its default.
 */
export function parseSettings(saved: string | null): Settings {
  const settings = defaultSettings();
  if (saved === null) return settings;
  let data: unknown;
  try {
    data = JSON.parse(saved);
  } catch {
    return settings;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return settings;
  }
  const record = settings as Record<SettingKey, unknown>;
  for (const key of SETTING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    const value = checkSetting(key, (data as Record<string, unknown>)[key]);
    if (value !== undefined) record[key] = value;
  }
  return fixKeyConflicts(settings);
}

/**
 * The two push-to-talk keys are never the same key. When a change makes
 * them equal, the other one takes the changed one's old key (a swap); with
 * nothing to swap with (saved settings from before voiceAllKey, whose team
 * key was L), the talk-to-all key is turned off.
 */
export function fixKeyConflicts(next: Settings, previous?: Settings): Settings {
  if (next.voiceKey === 'off' || next.voiceKey !== next.voiceAllKey) {
    return next;
  }
  if (previous && previous.voiceKey !== next.voiceKey) {
    return { ...next, voiceAllKey: previous.voiceKey };
  }
  if (previous && previous.voiceAllKey !== next.voiceAllKey) {
    return { ...next, voiceKey: previous.voiceAllKey };
  }
  return { ...next, voiceAllKey: 'off' };
}

export function serializeSettings(settings: Settings): string {
  return JSON.stringify(settings);
}

// Engine commands. Built only from checked values (numbers formatted here,
// names from fixed tables), and checked again against COMMAND_PATTERN.

const COMMAND_PATTERN =
  /^[a-z_]+ (?:[a-z]+|\d{1,3}(?:\.\d{1,3})?|"\d{1,3} \d{1,3} \d{1,3}")$/;

const CVARS: { [K in SettingKey]?: (value: Settings[K]) => string } = {
  sensitivity: (value) =>
    `sensitivity ${formatNumber(SETTINGS.sensitivity, value)}`,
  crosshairColor: (value) => `cl_crosshair_color "${CROSSHAIR_COLORS[value]}"`,
  crosshairSize: (value) => `cl_crosshair_size ${value}`,
  crosshairTranslucent: (value) => `cl_crosshair_translucent ${value ? 1 : 0}`,
  crosshairDynamic: (value) => `cl_dynamiccrosshair ${value ? 1 : 0}`,
  volume: (value) => `volume ${(value / 100).toFixed(2)}`,
};

function cvarCommand<K extends SettingKey>(
  key: K,
  settings: Settings
): string | undefined {
  const build = CVARS[key] as ((value: Settings[K]) => string) | undefined;
  if (!build) return;
  const value = checkSetting(key, settings[key]);
  if (value === undefined) throw new Error(`Invalid setting ${key}`);
  const command = build(value);
  if (!COMMAND_PATTERN.test(command)) {
    throw new Error(`Refusing to run an unsafe command: ${command}`);
  }
  return command;
}

/** Console commands that apply keys (all settings by default). */
export function cvarCommands(
  settings: Settings,
  keys: readonly SettingKey[] = SETTING_KEYS
): string[] {
  const commands: string[] = [];
  for (const key of keys) {
    const command = cvarCommand(key, settings);
    if (command) commands.push(command);
  }
  return commands;
}

/** CSS custom properties set on #hud. */
export function hudStyle(settings: Settings): Record<string, string> {
  return {
    '--hud-scale': String(settings.hudScale / 100),
    '--hud-opacity': String(settings.hudOpacity / 100),
  };
}

// A bad default would fall back to itself; fail the build instead (this
// module is imported by vite.config.ts).
for (const key of SETTING_KEYS) {
  if (checkSetting(key, SETTINGS[key].default) === undefined) {
    throw new Error(`Default for setting ${key} is invalid`);
  }
}
