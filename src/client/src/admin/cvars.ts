// Match cvars the admin menu can set, with the limits the menu allows. The
// server runs ReGameDLL_CS 5.30.0.814 (built with REGAMEDLL_ADD and
// REGAMEDLL_FIXES), which clamps far less than the stock game library did:
// the limits below are inside ReGameDLL's ranges, so the game never changes
// a value the menu sent, and where the game has no limit they are our own
// caps. Every value is checked here before it is put into a command line.

export type CvarName =
  | 'mp_friendlyfire'
  | 'sv_alltalk'
  | 'sv_voiceenable'
  | 'wc_voice_all'
  | 'mp_timelimit'
  | 'mp_roundtime'
  | 'mp_startmoney'
  | 'mp_freezetime'
  | 'mp_buytime'
  | 'mp_maxrounds'
  | 'wc_weaponmode'
  | 'wc_gamemode'
  | 'wc_dm_fraglimit'
  | 'wc_gg_kills_per_level'
  | 'wc_gg_suicide_penalty'
  | 'wc_gg_join_lowest';

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
   * the menu sent: only our plugins' resets of wc_weaponmode and
   * wc_gamemode.
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
  // The engine's cvar: voice chat (src/server/voice_roster.go) lets
  // everyone hear everyone, enemies and the dead included.
  sv_alltalk: {
    name: 'sv_alltalk',
    label: 'All talk (voice)',
    unit: '',
    kind: 'bool',
    min: 0,
    max: 1,
    decimals: 0,
    applies: 'now',
  },
  // The engine's cvar, which the roster plugin reports: 0 turns voice chat
  // off at once (the server forwards nothing; src/server/voice_roster.go).
  sv_voiceenable: {
    name: 'sv_voiceenable',
    label: 'Voice chat',
    unit: '',
    kind: 'bool',
    min: 0,
    max: 1,
    decimals: 0,
    applies: 'now',
  },
  // Our cvar (src/amxx/wc_roster.sma, kept over map changes): 0 makes the
  // players' talk-to-all key (L) talk to their team only.
  wc_voice_all: {
    name: 'wc_voice_all',
    label: 'Talk to all key (voice)',
    unit: '',
    kind: 'bool',
    min: 0,
    max: 1,
    decimals: 0,
    applies: 'now',
  },
  // 0 means no limit. The game has no clamp (a negative value counts as 0);
  // 600 minutes is our own cap.
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
  // ReGameDLL clamps it to 0–500 minutes (0: the round never times out);
  // 1–9 is our own range, the classic game's.
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
  // ReGameDLL clamps it to 0–mp_maxmoney (16000, not changed here); 800 is
  // our own minimum. It is given out on a full restart.
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
  // ReGameDLL only raises a negative value to 0 and drops any fraction;
  // 60 seconds is our own cap.
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
  // ReGameDLL has no clamp (0 turns buying off, -1 means no limit); 0.25
  // (15 seconds, the stock game's minimum) is our own minimum, and buying
  // ends with the round anyway, so the cap is the longest round time.
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
  // 0 means no limit. The game only raises a negative value to 0; it ends
  // the map once this many rounds have been played. 100 is our own cap.
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
  // Our AMX Mod X plugin (src/amxx/wc_gamemode.sma). A change restarts the
  // game; the plugin sets it back to 0 when a map starts. While it isn't 0,
  // the weapon mode plugin keeps wc_weaponmode at 0.
  wc_gamemode: {
    name: 'wc_gamemode',
    label: 'Game mode',
    unit: '',
    kind: 'choice',
    choices: ['classic', 'gun game', 'deathmatch'],
    min: 0,
    max: 2,
    decimals: 0,
    applies: 'now',
    mapReset: 0,
  },
  // Our plugin too: in Deathmatch the map ends when a player gets this many
  // frags (it sets ReGameDLL's mp_fraglimit). 0 means no limit; 500 is our
  // own cap. Kept over map changes.
  wc_dm_fraglimit: {
    name: 'wc_dm_fraglimit',
    label: 'Deathmatch frag limit',
    unit: 'frags',
    kind: 'number',
    min: 0,
    max: 500,
    decimals: 0,
    applies: 'now',
  },
  // Gun Game rules (our plugin too), kept over map changes. Kills with the
  // level's weapon needed for the next level; 10 is our own cap.
  wc_gg_kills_per_level: {
    name: 'wc_gg_kills_per_level',
    label: 'Gun Game kills per level',
    unit: 'kills',
    kind: 'number',
    min: 1,
    max: 10,
    decimals: 0,
    applies: 'now',
  },
  wc_gg_suicide_penalty: {
    name: 'wc_gg_suicide_penalty',
    label: 'Gun Game: suicide loses a level',
    unit: '',
    kind: 'bool',
    min: 0,
    max: 1,
    decimals: 0,
    applies: 'now',
  },
  wc_gg_join_lowest: {
    name: 'wc_gg_join_lowest',
    label: 'Gun Game: late joiners start at the lowest level',
    unit: '',
    kind: 'bool',
    min: 0,
    max: 1,
    decimals: 0,
    applies: 'now',
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
