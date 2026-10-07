// Kill details for the "Killed by" card (D.1), without DOM. The server
// plugin (src/amxx/wc_killinfo.sma) sends the user message WcKillInfo to the
// victim of a player kill, only when their userinfo has wc_html_hud 1 (set
// by hud.ts from the same client version as the `mode` event). The game
// client turns it into the bridge's `killinfo` event, right after the
// `kill` event it belongs to. The card (D.4) reads it from here.

import type { KillEvent } from './stats';
import { versionAtLeast } from './gamemode';

/**
 * First cs16-client release whose bridge sends the `killinfo` event (the
 * same release as the `mode` event).
 */
export const KILLINFO_EVENT_CLIENT_VERSION = '0.0.10';

/** True when a client of this version sends `killinfo` events. */
export function killInfoSupported(clientVersion: string): boolean {
  return versionAtLeast(clientVersion, KILLINFO_EVENT_CLIENT_VERSION);
}

/** Payload of the bridge's `killinfo` event (cs16-client 0.0.10+). */
export type KillInfo = {
  /** The killer's server userid (matches `kill`'s killerUserid). */
  killerUserid: number;
  /** The killer's health and armour when the kill happened; 0 health if
   * they were already dead (a grenade thrown before dying). */
  health: number;
  armor: number;
  /** DeathMsg weapon name, as in the `kill` event ("ak47", "grenade"). */
  weapon: string;
  headshot: boolean;
  /** The killer was fully blinded by a flashbang (gun kills only). */
  blind: boolean;
  /** The bullet went through a wall (not just through another player). */
  wall: boolean;
  /** Killer to victim in metres, rounded. */
  distance: number;
};

function int(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}

function flag(value: unknown): boolean {
  return value === true || (typeof value === 'number' && value !== 0);
}

/**
 * Reads a `killinfo` payload; missing or bad numbers become 0, flags
 * false. Undefined without a killer userid (nothing to match it to).
 */
export function parseKillInfo(payload: unknown): KillInfo | undefined {
  const p = (payload ?? {}) as Record<string, unknown>;
  const killerUserid = int(p.killerUserid);
  if (killerUserid === 0) return undefined;
  return {
    killerUserid,
    health: int(p.health),
    armor: int(p.armor),
    weapon: typeof p.weapon === 'string' ? p.weapon : '',
    headshot: flag(p.headshot),
    blind: flag(p.blind),
    wall: flag(p.wall),
    distance: int(p.distance),
  };
}

/**
 * True when the details belong to this kill: same killer userid and
 * weapon. A `kill` without userids (cs16-client before 0.0.7) never
 * matches.
 */
export function killInfoMatches(kill: KillEvent, info: KillInfo): boolean {
  return (
    kill.killerUserid !== undefined &&
    kill.killerUserid === info.killerUserid &&
    kill.weapon === info.weapon
  );
}
