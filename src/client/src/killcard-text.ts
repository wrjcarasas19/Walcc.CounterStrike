// "Killed by" card (D.4), without DOM: which card a death gets, its texts,
// the all-time line and spotting bomb deaths. killcard.ts draws it.

import type { KillInfo } from './killinfo';
import type { Duel, KillEvent, Team } from './stats';

/** How long the card stays up (unless the player respawns or a round starts). */
export const KILL_CARD_MS = 6_000;

/**
 * With a bridge that sends `killinfo` (cs16-client 0.0.10+), how long the
 * card waits for it after the `kill` event. The bridge sends it right after
 * the kill, in the same frame; details that come later still fill in.
 */
export const KILL_INFO_WAIT_MS = 250;

/** The killer's streak is shown from this many kills. */
export const STREAK_MIN = 3;

/**
 * A `round` event with reason "bomb" and the local player dying without a
 * kill event at most this far apart: killed by the bomb. The game sends no
 * DeathMsg for bomb deaths (CBasePlayer::Killed skips PlayerKilled).
 */
export const BOMB_DEATH_WINDOW_MS = 1_500;

export type KillCardKind =
  'enemy' | 'teammate' | 'self' | 'grenade' | 'fall' | 'world' | 'bomb';

export type WeaponKind = 'knife' | 'grenade' | 'gun' | '';

/** What the card shows; empty strings are left out. */
export type KillCard = {
  kind: KillCardKind;
  /** "Killed by", "Killed by teammate", or the whole line for short cards. */
  title: string;
  killer: string;
  killerTeam: Team;
  weapon: string;
  weaponKind: WeaponKind;
  headshot: boolean;
};

const WEAPON_LABELS: Record<string, string> = {
  p228: 'P228',
  scout: 'Scout',
  hegrenade: 'HE Grenade',
  grenade: 'HE Grenade',
  xm1014: 'XM1014',
  c4: 'C4',
  mac10: 'MAC-10',
  aug: 'AUG',
  smokegrenade: 'Smoke',
  elite: 'Dual Elites',
  fiveseven: 'Five-SeveN',
  ump45: 'UMP-45',
  sg550: 'SG 550',
  galil: 'Galil',
  famas: 'FAMAS',
  usp: 'USP',
  glock18: 'Glock-18',
  awp: 'AWP',
  mp5navy: 'MP5',
  m249: 'M249',
  m3: 'M3',
  m4a1: 'M4A1',
  tmp: 'TMP',
  g3sg1: 'G3SG1',
  flashbang: 'Flashbang',
  deagle: 'Desert Eagle',
  sg552: 'SG 552',
  ak47: 'AK-47',
  knife: 'Knife',
  p90: 'P90',
};

/** Display name of a DeathMsg weapon ("ak47" -> "AK-47"). */
export function weaponLabel(weapon: string): string {
  return WEAPON_LABELS[weapon] ?? weapon;
}

/** Which icon the weapon gets. */
export function weaponKind(weapon: string): WeaponKind {
  if (!weapon) return '';
  if (weapon === 'knife') return 'knife';
  if (weapon === 'grenade' || weapon.endsWith('grenade')) return 'grenade';
  if (weapon === 'flashbang') return 'grenade';
  return 'gun';
}

/**
 * The card for a kill event, or undefined when the local player isn't the
 * victim (or the victim is an object). localName is the local player's
 * in-game name (SessionStats.localName()).
 */
export function killCardFor(
  kill: KillEvent,
  localName: string
): KillCard | undefined {
  if (!localName || !kill.victim || kill.victim !== localName) return undefined;
  // An object victim (a breakable) has the object's name and no team.
  if (!kill.victimTeam && kill.victim === kill.weapon) return undefined;
  const base = {
    killer: '',
    killerTeam: '' as Team,
    weapon: '',
    weaponKind: '' as WeaponKind,
    headshot: false,
  };
  // The bridge sends "" for the killer on world kills; the `kill` console
  // command and own grenades name the victim as the killer, or nobody.
  if (!kill.killer || kill.killer === kill.victim) {
    switch (kill.weapon) {
      case 'grenade':
        return {
          ...base,
          kind: 'grenade',
          title: 'Killed by your own grenade',
        };
      case 'worldspawn':
        // World damage: falls (drowning too, which CS maps rarely allow).
        return { ...base, kind: 'fall', title: 'You fell to your death' };
      case 'world':
      case '':
        return { ...base, kind: 'self', title: 'You killed yourself' };
      default:
        // trigger_hurt, a door...: something in the map.
        return { ...base, kind: 'world', title: 'Killed by the map' };
    }
  }
  const card = {
    ...base,
    killer: kill.killer,
    killerTeam: kill.killerTeam,
    weapon: weaponLabel(kill.weapon),
    weaponKind: weaponKind(kill.weapon),
    headshot: kill.headshot,
  };
  if (kill.killerTeam !== '' && kill.killerTeam === kill.victimTeam) {
    return { ...card, kind: 'teammate', title: 'Killed by teammate' };
  }
  return { ...card, kind: 'enemy', title: 'Killed by' };
}

/** The card for a bomb death (no kill event; see createBombDeathDetector). */
export function bombCard(): KillCard {
  return {
    kind: 'bomb',
    title: 'Killed by the bomb',
    killer: '',
    killerTeam: '',
    weapon: '',
    weaponKind: '',
    headshot: false,
  };
}

/** Whether a card kind gets the duel and streak lines. */
export function hasDuelLines(kind: KillCardKind): boolean {
  return kind === 'enemy';
}

/**
 * "87 HP · 100 armour · 23 m" from the `killinfo` event; "Killer already
 * dead" instead of HP / armour when they died first (a grenade thrown
 * before dying).
 */
export function detailsText(info: KillInfo): string {
  const parts =
    info.health > 0
      ? [`${info.health} HP`, `${info.armor} armour`]
      : ['Killer already dead'];
  parts.push(`${info.distance} m`);
  return parts.join(' · ');
}

/** "Through a wall", "Killer was blind" tags from the `killinfo` event. */
export function detailTags(info: KillInfo): string[] {
  const tags: string[] = [];
  if (info.wall) tags.push('Through a wall');
  if (info.blind) tags.push('Killer was blind');
  return tags;
}

/** "This map: you 2 – 5 Walter" (duel is stats.duel(you, killer)). */
export function mapLineText(duel: Duel, killer: string): string {
  return `This map: you ${duel.aKills} – ${duel.bKills} ${killer}`;
}

/** "All time: 14 – 22" (you first). */
export function allTimeLineText(duel: Duel): string {
  return `All time: ${duel.aKills} – ${duel.bKills}`;
}

/** "Walter is on a 6 kill streak", or "" under STREAK_MIN. */
export function streakText(killer: string, streak: number | undefined): string {
  if (streak === undefined || streak < STREAK_MIN) return '';
  return `${killer} is on a ${streak} kill streak`;
}

/**
 * The all-time record, fetched once per killer per map (GET /duel) and kept
 * up to date with the map's own counts after that: server + (map now - map
 * when fetched). killcard.ts fetches it a few seconds after the death, when
 * the server (it reads the game logs every 2 s) has the kill, so the map
 * counts at fetch time include it. No line when the server has nothing for
 * the pair from before this map (it would only repeat "This map"; bots are
 * often not counted there at all).
 */
export function allTimeDuel(
  server: Duel,
  mapAtFetch: Duel,
  mapNow: Duel
): Duel | undefined {
  const before =
    Math.max(0, server.aKills - mapAtFetch.aKills) +
    Math.max(0, server.bKills - mapAtFetch.bKills);
  if (before === 0) return undefined;
  return {
    aKills: server.aKills + Math.max(0, mapNow.aKills - mapAtFetch.aKills),
    bKills: server.bKills + Math.max(0, mapNow.bKills - mapAtFetch.bKills),
  };
}

/** Reads a /duel answer; undefined unless both counts are numbers. */
export function parseDuel(body: unknown): Duel | undefined {
  const p = (body ?? {}) as Record<string, unknown>;
  const ok = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!ok(p.aKills) || !ok(p.bKills)) return undefined;
  return { aKills: Math.round(p.aKills), bKills: Math.round(p.bKills) };
}

/** The /duel URL for me against them (exact in-game names). */
export function duelUrl(me: string, them: string): string {
  return `/duel?a=${encodeURIComponent(me)}&b=${encodeURIComponent(them)}`;
}

/**
 * Spots bomb deaths: the local player going from alive to dead without a
 * kill event for them, and a `round` event with reason "bomb", in either
 * order within BOMB_DEATH_WINDOW_MS. Each method returns true when that
 * makes a bomb death.
 */
export function createBombDeathDetector(windowMs = BOMB_DEATH_WINDOW_MS) {
  let killedAt = -Infinity;
  let unexplainedAt = -Infinity;
  let bombAt = -Infinity;
  return {
    /** A kill event with the local player as the victim. */
    killed(now: number): void {
      killedAt = now;
      unexplainedAt = -Infinity;
    },
    /** The local player went from alive to dead. */
    died(now: number): boolean {
      if (now - killedAt <= windowMs) return false;
      if (now - bombAt <= windowMs) {
        bombAt = -Infinity;
        return true;
      }
      unexplainedAt = now;
      return false;
    },
    /** A round ended. */
    round(reason: string, now: number): boolean {
      if (reason !== 'bomb') return false;
      if (now - unexplainedAt <= windowMs) {
        unexplainedAt = -Infinity;
        return true;
      }
      bombAt = now;
      return false;
    },
    reset(): void {
      killedAt = unexplainedAt = bombAt = -Infinity;
    },
  };
}
