// Match cvars the admin menu can set, with the limits the game itself
// applies. The server runs the stock CS 1.6 game library (HLDS build 8308,
// not ReGameDLL), which clamps some of these on its own; the limits below
// match those clamps so the menu never sends a value the game would change.
// Every value is checked here before it is put into a command line.

export type CvarName =
  | 'mp_friendlyfire'
  | 'mp_timelimit'
  | 'mp_roundtime'
  | 'mp_startmoney'
  | 'mp_freezetime'
  | 'mp_buytime'
  | 'mp_maxrounds'
  | 'wc_weaponmode';

/** When a new value takes effect in a running game. */
export type CvarApplies = 'now' | 'next round' | 'restart';

export type CvarDef = {
  name: CvarName;
  label: string;
  /** Shown after the range, e.g. "min". Empty for on/off. */
  unit: string;
  /**
   * 'bool' is 0 or 1; 'choice' is a whole number from min to max, named by
   * `choices`; numbers allow up to `decimals` decimal places.
   */
  kind: 'bool' | 'choice' | 'number';
  /** For 'choice': the name of each value, from min (0) up. */
  choices?: readonly string[];
  min: number;
  max: number;
  decimals: number;
  applies: CvarApplies;
  /**
   * The value the cvar goes back to on every map change, overwriting what
   * the menu sent: only the weapon mode plugin's reset of wc_weaponmode.
   * configs/cstrike/server.cfg runs once at server start, not on map change,
   * so the cvars it sets keep the menu's value. Keep in sync with the plugin.
   */
  mapReset?: number;
};

export const CVARS: Readonly<Record<CvarName, CvarDef>> = {
  mp_friendlyfire: {
    name: 'mp_friendlyfire',
    label: 'Friendly fire',
    unit: '',
    kind: 'bool',
    min: 0,
    max: 1,
    decimals: 0,
    applies: 'now',
  },
  // 0 means no limit. The game only refuses negative values; 600 minutes
  // is our own cap.
  mp_timelimit: {
    name: 'mp_timelimit',
    label: 'Time limit',
    unit: 'min',
    kind: 'number',
    min: 0,
    max: 600,
    decimals: 0,
    applies: 'now',
  },
  // The game clamps it to 1–9 minutes.
  mp_roundtime: {
    name: 'mp_roundtime',
    label: 'Round time',
    unit: 'min',
    kind: 'number',
    min: 1,
    max: 9,
    decimals: 2,
    applies: 'next round',
  },
  // The game clamps it to 800–16000; it is given out on a full restart.
  mp_startmoney: {
    name: 'mp_startmoney',
    label: 'Start money',
    unit: '$',
    kind: 'number',
    min: 800,
    max: 16000,
    decimals: 0,
    applies: 'restart',
  },
  // The game clamps it to 0–60 seconds and drops any fraction.
  mp_freezetime: {
    name: 'mp_freezetime',
    label: 'Freeze time',
    unit: 's',
    kind: 'number',
    min: 0,
    max: 60,
    decimals: 0,
    applies: 'next round',
  },
  // The game raises anything under 15 seconds (0.25 min) to 0.25. It has no
  // upper clamp, but buying ends with the round anyway, so the cap is the
  // longest round time.
  mp_buytime: {
    name: 'mp_buytime',
    label: 'Buy time',
    unit: 'min',
    kind: 'number',
    min: 0.25,
    max: 9,
    decimals: 2,
    applies: 'now',
  },
  // 0 means no limit. The game has no clamp; it ends the map once this many
  // rounds have been played. 100 is our own cap.
  mp_maxrounds: {
    name: 'mp_maxrounds',
    label: 'Max rounds',
    unit: 'rounds',
    kind: 'number',
    min: 0,
    max: 100,
    decimals: 0,
    applies: 'now',
  },
  // Our AMX Mod X plugin (src/amxx/wc_weaponmode.sma). It sets the cvar
  // back to 0 when a map starts; a round restart keeps it.
  wc_weaponmode: {
    name: 'wc_weaponmode',
    label: 'Weapon mode',
    unit: '',
    kind: 'choice',
    choices: ['normal', 'knife only', 'pistols only'],
    min: 0,
    max: 2,
    decimals: 0,
    applies: 'now',
    mapReset: 0,
  },
};

/** Digits with an optional fraction; no sign, exponent or spaces inside. */
const NUMBER_PATTERN = /^(\d{1,6}(\.\d*)?|\.\d+)$/;

export type ParseResult =
  { ok: true; value: number } | { ok: false; error: string };

/** "$800–$16000", "1–9 min", "on or off": the allowed values. */
export function describeRange(def: CvarDef): string {
  if (def.kind === 'bool') return 'on or off';
  if (def.kind === 'choice') {
    const names = choiceNames(def);
    return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  }
  const min = formatCvarValue(def, def.min);
  const max = formatCvarValue(def, def.max);
  if (def.unit === '$') return `$${min}–$${max}`;
  return `${min}–${max}${def.unit ? ` ${def.unit}` : ''}`;
}

/**
 * Returns an error message if value can't be sent for def: not finite, out
 * of range, or with more decimal places than allowed.
 */
export function checkCvarValue(def: CvarDef, value: number): string | null {
  if (!Number.isFinite(value)) return `${def.label} must be a number.`;
  if (value < def.min || value > def.max) {
    return `${def.label} must be ${describeRange(def)}.`;
  }
  const scale = 10 ** def.decimals;
  if (Math.abs(Math.round(value * scale) - value * scale) > 1e-9) {
    return def.decimals === 0
      ? `${def.label} must be a whole number.`
      : `${def.label} can have at most ${def.decimals} decimal places.`;
  }
  return null;
}

/** Parses what the admin typed (or the select's value for on/off). */
export function parseCvarValue(def: CvarDef, raw: string): ParseResult {
  const text = raw.trim();
  if (def.kind === 'bool') {
    if (text === '0' || text === '1') return { ok: true, value: Number(text) };
    return { ok: false, error: `${def.label} must be on or off.` };
  }
  if (def.kind === 'choice') {
    const value = Number(text);
    if (/^\d{1,2}$/.test(text) && checkCvarValue(def, value) === null) {
      return { ok: true, value };
    }
    return { ok: false, error: `${def.label} must be ${describeRange(def)}.` };
  }
  if (!NUMBER_PATTERN.test(text)) {
    return { ok: false, error: `${def.label} must be a number.` };
  }
  const value = Number(text);
  const error = checkCvarValue(def, value);
  return error ? { ok: false, error } : { ok: true, value };
}

/** The name of each value of a 'choice' cvar, from min up. */
export function choiceNames(def: CvarDef): readonly string[] {
  const names = def.choices ?? [];
  if (names.length !== def.max - def.min + 1) {
    throw new Error(`${def.name} needs one name per value.`);
  }
  return names;
}

/** "knife only": the name of a 'choice' cvar's value. */
export function choiceName(def: CvarDef, value: number): string {
  return choiceNames(def)[value - def.min] ?? String(value);
}

/** The value as it goes into the command: no exponent, no trailing zeros. */
export function formatCvarValue(def: CvarDef, value: number): string {
  return String(Number(value.toFixed(def.decimals)));
}

/** `<name> <value>`. Throws if the value fails checkCvarValue. */
export function cvarCommand(def: CvarDef, value: number): string {
  const error = checkCvarValue(def, value);
  if (error) throw new Error(error);
  return `${def.name} ${formatCvarValue(def, value)}`;
}

// A 'choice' cvar without a name for each value fails here, at load (and so
// in the build: vite.config.ts imports presets.ts, which imports this file).
for (const def of Object.values(CVARS)) {
  if (def.kind === 'choice') choiceNames(def);
}
