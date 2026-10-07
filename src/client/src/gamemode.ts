// Gun Game and Deathmatch on the HTML HUD (A.4), without DOM: the bridge's
// `mode` event, the Gun Game strip text and the level toast. hud.ts draws
// them. The server plugin (src/amxx/wc_gamemode.sma) sends the user message
// WcMode only to players whose userinfo has wc_html_hud 1, which the page
// sets when its cs16-client forwards it (MODE_EVENT_CLIENT_VERSION).

/** First cs16-client release whose bridge sends the `mode` event. */
export const MODE_EVENT_CLIENT_VERSION = '0.0.10';

export const GAME_MODE_CLASSIC = 0;
export const GAME_MODE_GUN_GAME = 1;
export const GAME_MODE_DEATHMATCH = 2;

/** Payload of the bridge's `mode` event (cs16-client 0.0.10+). */
export type ModeState = {
  /** 0 classic (the mode ended), 1 Gun Game, 2 Deathmatch. */
  mode: number;
  /** Gun Game: 1-based level and number of levels; 0 otherwise. */
  level: number;
  levels: number;
  /** Gun Game: counting kills on this level, and kills per level (>= 1). */
  kills: number;
  killsNeeded: number;
  /** Gun Game: this level's and the next level's weapon ("" on the last). */
  weapon: string;
  next: string;
  /** Gun Game: the leader's name ("" none) and 1-based level. */
  leader: string;
  leaderLevel: number;
  /** Gun Game: the winner's name once someone won, "" before. */
  winner: string;
  /** Spawn protection left in ms when the event was sent; 0 none. */
  protection: number;
};

function int(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Reads a `mode` payload; missing or bad fields become 0 / "". */
export function parseModeState(payload: unknown): ModeState {
  const p = (payload ?? {}) as Record<string, unknown>;
  const mode = int(p.mode);
  return {
    mode: mode <= GAME_MODE_DEATHMATCH ? mode : GAME_MODE_CLASSIC,
    level: int(p.level),
    levels: int(p.levels),
    kills: int(p.kills),
    killsNeeded: int(p.killsNeeded),
    weapon: str(p.weapon),
    next: str(p.next),
    leader: str(p.leader),
    leaderLevel: int(p.leaderLevel),
    winner: str(p.winner),
    protection: int(p.protection),
  };
}

/** True when the state has a Gun Game level to show. */
export function isGunGame(state: ModeState | undefined): state is ModeState {
  return (
    state !== undefined &&
    state.mode === GAME_MODE_GUN_GAME &&
    state.levels > 0 &&
    state.level > 0
  );
}

export type GunGameStrip = {
  /** "7 / 24" */
  level: string;
  /** "MP5" */
  weapon: string;
  /** "UMP45 next", "1/2 kills · UMP45 next", "last level"; "" if won. */
  next: string;
  /** "Leader Walter (12)", "" without a leader. */
  leader: string;
  /** "Walter won Gun Game!" once won, else "". */
  winner: string;
};

/** The Gun Game strip under the timer: "7 / 24 · MP5 → UMP45 next". */
export function gunGameStrip(state: ModeState): GunGameStrip {
  const parts: string[] = [];
  if (state.killsNeeded > 1 && state.level < state.levels) {
    parts.push(`${state.kills}/${state.killsNeeded} kills`);
  }
  parts.push(state.next ? `${state.next} next` : 'last level');
  return {
    level: `${state.level} / ${state.levels}`,
    weapon: state.weapon,
    next: state.winner ? '' : parts.join(' · '),
    leader:
      state.leader && state.leaderLevel > 0
        ? `Leader ${state.leader} (${state.leaderLevel})`
        : '',
    winner: state.winner ? `${state.winner} won Gun Game!` : '',
  };
}

/**
 * The toast for a level change from prev to state: "Level 8: UMP45", or
 * "Down to level 6: Desert Eagle" (knifed, suicide penalty); "" for none
 * (first state, other mode, ladder changed, game won).
 */
export function levelToast(
  prev: ModeState | undefined,
  state: ModeState
): string {
  if (!isGunGame(prev) || !isGunGame(state)) return '';
  if (state.winner || prev.levels !== state.levels) return '';
  if (state.level > prev.level) return `Level ${state.level}: ${state.weapon}`;
  if (state.level < prev.level) {
    return `Down to level ${state.level}: ${state.weapon}`;
  }
  return '';
}

/** "0.0.10" >= "0.0.9": compares dot-separated numbers; junk is 0. */
export function versionAtLeast(version: string, min: string): boolean {
  const parse = (v: string) =>
    v
      .split(/[.+-]/)
      .slice(0, 3)
      .map((n) => (/^\d+$/.test(n) ? Number(n) : 0));
  const a = parse(version);
  const b = parse(min);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}
