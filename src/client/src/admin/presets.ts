import { CVARS, checkCvarValue, type CvarName } from './cvars';

// Game mode presets for the Match tab: a group of cvars sent together, then
// a round restart. Add a preset by adding a row here. No DOM here, so
// vite.config.ts can import this file and fail the build on a bad value.

export type Preset = {
  /** Used for element ids; letters, digits and dashes. */
  id: string;
  label: string;
  values: Partial<Record<CvarName, number>>;
};

export const PRESETS: readonly Preset[] = [
  {
    id: 'casual',
    label: 'Casual',
    values: {
      mp_friendlyfire: 0,
      mp_startmoney: 16000,
      mp_freezetime: 0,
      mp_buytime: 0.5,
      mp_roundtime: 3,
      wc_weaponmode: 0,
      wc_gamemode: 0,
    },
  },
  {
    id: 'competitive',
    label: 'Competitive',
    values: {
      mp_friendlyfire: 1,
      mp_startmoney: 800,
      mp_freezetime: 6,
      mp_roundtime: 1.75,
      mp_maxrounds: 30,
      wc_weaponmode: 0,
      wc_gamemode: 0,
    },
  },
  {
    id: 'warmup',
    label: 'Warmup',
    values: {
      mp_startmoney: 16000,
      mp_freezetime: 0,
      mp_roundtime: 9,
      mp_buytime: 9,
      wc_weaponmode: 0,
      wc_gamemode: 0,
    },
  },
  // Gun Game / Deathmatch (src/amxx/wc_gamemode.sma): respawns and endless
  // rounds, so no freeze time. Gun Game hands out the weapons (nothing to
  // buy); Deathmatch has a guns menu. The presets above turn them off.
  {
    id: 'gungame',
    label: 'Gun Game',
    values: {
      mp_friendlyfire: 0,
      mp_startmoney: 800,
      mp_freezetime: 0,
      mp_buytime: 0.25,
      wc_weaponmode: 0,
      wc_gamemode: 1,
    },
  },
  {
    id: 'deathmatch',
    label: 'Deathmatch',
    values: {
      mp_friendlyfire: 0,
      mp_startmoney: 16000,
      mp_freezetime: 0,
      mp_buytime: 0.25,
      wc_weaponmode: 0,
      wc_gamemode: 2,
    },
  },
  // Knife only / pistols only (src/amxx/wc_weaponmode.sma); the other
  // settings stay as they are. The presets above turn the mode off. They
  // do nothing during Gun Game or Deathmatch (the plugin refuses them and
  // the Match tab says so).
  {
    id: 'knife',
    label: 'Knife only',
    values: { wc_weaponmode: 1 },
  },
  {
    id: 'pistols',
    label: 'Pistols only',
    values: { wc_weaponmode: 2 },
  },
];

// fy_, aim_ and awp_ maps set their own match settings a few seconds after
// they load (configs/cstrike/addons/amxmodx/configs/maps/prefix_*.cfg), over
// what the Match tab set, and the map after one gets the stock values back
// (configs/cstrike/leave_funmap.cfg). Keep these in step with those files.
export const FUN_MAP_PREFIXES: readonly string[] = ['fy_', 'aim_', 'awp_'];

export const FUN_MAP_VALUES: Partial<Record<CvarName, number>> = {
  mp_startmoney: 16000,
  mp_freezetime: 0,
  mp_roundtime: 2,
  mp_buytime: 0.25,
};

export const AFTER_FUN_MAP_VALUES: Partial<Record<CvarName, number>> = {
  mp_startmoney: 800,
  mp_freezetime: 6,
  mp_roundtime: 5,
  mp_buytime: 1.5,
};

/** Whether the map runs its own settings when it loads. */
export function isFunMap(map: string): boolean {
  return FUN_MAP_PREFIXES.some((prefix) => map.startsWith(prefix));
}

/** Every problem with the table: bad ids, duplicates, values out of range. */
export function checkPresets(presets: readonly Preset[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const { id, label, values } of presets) {
    if (!/^[a-z0-9-]+$/.test(id)) errors.push(`Preset id "${id}" is invalid.`);
    if (ids.has(id)) errors.push(`Preset id "${id}" is used twice.`);
    ids.add(id);
    const entries = Object.entries(values);
    if (entries.length === 0) errors.push(`Preset ${label} sets nothing.`);
    for (const [name, value] of entries) {
      const def = CVARS[name as CvarName];
      if (!def) {
        errors.push(`Preset ${label}: unknown cvar ${name}.`);
        continue;
      }
      const error = checkCvarValue(def, value);
      if (error) errors.push(`Preset ${label}: ${error}`);
    }
  }
  return errors;
}

const errors = checkPresets([
  ...PRESETS,
  { id: 'fun-map', label: 'Fun map', values: FUN_MAP_VALUES },
  {
    id: 'after-fun-map',
    label: 'After a fun map',
    values: AFTER_FUN_MAP_VALUES,
  },
]);
if (errors.length > 0) {
  throw new Error(`Invalid game mode presets:\n${errors.join('\n')}`);
}
