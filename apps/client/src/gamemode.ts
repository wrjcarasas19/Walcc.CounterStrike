// Gun Game, Deathmatch, Zombies and Survival on the HTML HUD (A.4), without
// DOM: the bridge's `mode` event, the strip text and the level and wave
// toasts. hud.ts draws
// them. The server plugin (apps/amxx/wc_gamemode.sma) sends the user message
// WcMode only to players whose userinfo has wc_html_hud 1, which the page
// sets when its cs16-client forwards it (MODE_EVENT_CLIENT_VERSION). The
// client (web_bridge.cpp) passes the fields through without checking them,
// so later modes reuse them with their own meaning (ModeState below); no
// newer client is needed for them.

/** First cs16-client release whose bridge sends the `mode` event. */
export const MODE_EVENT_CLIENT_VERSION = '0.0.10';

export const GAME_MODE_CLASSIC = 0;
export const GAME_MODE_GUN_GAME = 1;
export const GAME_MODE_DEATHMATCH = 2;
export const GAME_MODE_ZOMBIES = 3;
export const GAME_MODE_SURVIVAL = 4;
/** The highest wc_gamemode the page knows. */
const GAME_MODE_MAX = GAME_MODE_SURVIVAL;

/** Payload of the bridge's `mode` event (cs16-client 0.0.10+). */
export type ModeState = {
  /**
   * 0 classic (the mode ended), 1 Gun Game, 2 Deathmatch, 3 Zombies,
   * 4 Survival.
   */
  mode: number;
  /**
   * Gun Game: 1-based level and number of levels. Zombies: the round
   * number (levels 0). Survival: the wave and the waves to win. 0
   * otherwise.
   */
  level: number;
  levels: number;
  /**
   * Gun Game: counting kills on this level, and kills per level (>= 1).
   * Zombies: zombies left, and zombies at the start of the round.
   * Survival: bots killed this wave, and the wave's size (at most 255).
   */
  kills: number;
  killsNeeded: number;
  /**
   * Gun Game: this level's and the next level's weapon ("" on the last).
   * Zombies: weapon is "Zombies". Survival: weapon is "Wave", "Boss" (a
   * boss is alive) or "Break", and next the seconds left in the break
   * ("8"; "" otherwise).
   */
  weapon: string;
  next: string;
  /** Gun Game: the leader's name ("" none) and 1-based level. */
  leader: string;
  leaderLevel: number;
  /**
   * Gun Game: the winner's name once someone won; Survival: "Humans" once
   * all waves are cleared; "" before.
   */
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
    mode: mode <= GAME_MODE_MAX ? mode : GAME_MODE_CLASSIC,
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

/**
 * Rounds never end in this mode (Gun Game, Deathmatch): the announcer
 * counts first blood and last man per map instead of per round.
 */
export function endlessRounds(mode: number): boolean {
  return (
    mode === GAME_MODE_GUN_GAME ||
    mode === GAME_MODE_DEATHMATCH ||
    mode === GAME_MODE_SURVIVAL
  );
}

/** A mode played against bots, with co-op always on (Zombies, Survival). */
export function againstBots(mode: number): boolean {
  return mode === GAME_MODE_ZOMBIES || mode === GAME_MODE_SURVIVAL;
}

/** True when the state has a Survival wave to show. */
export function isSurvival(state: ModeState): boolean {
  return state.mode === GAME_MODE_SURVIVAL && state.level > 0;
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
 * The strip under the timer for any mode that has one (Gun Game, Zombies,
 * Survival), in the Gun Game strip's parts; undefined for none. Zombies:
 * "Round 3 · Zombies | 5 / 9 left". Survival: "Wave 4 / 10 | 12 / 20
 * killed", "Wave 5 / 10 · Boss | 3 / 22 killed", "Wave 4 / 10 · Break →
 * next wave in 8 s", "Survived!".
 */
export function modeStrip(
  state: ModeState | undefined
): GunGameStrip | undefined {
  if (state && isSurvival(state)) {
    const breakTime = state.weapon === 'Break';
    return {
      level: `Wave ${state.level} / ${state.levels}`,
      weapon: state.weapon === 'Boss' || breakTime ? state.weapon : '',
      next:
        breakTime && !state.winner && state.next
          ? `next wave in ${state.next} s`
          : '',
      leader:
        breakTime || state.winner
          ? ''
          : `${state.kills} / ${state.killsNeeded} killed`,
      winner: state.winner ? 'Survived!' : '',
    };
  }
  if (state?.mode === GAME_MODE_ZOMBIES) {
    return {
      level: `Round ${Math.max(state.level, 1)}`,
      weapon: state.weapon || 'Zombies',
      next: '',
      leader:
        state.killsNeeded > 0
          ? `${state.kills} / ${state.killsNeeded} left`
          : `${state.kills} left`,
      winner: '',
    };
  }
  return isGunGame(state) ? gunGameStrip(state) : undefined;
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
  if (prev && isSurvival(prev) && isSurvival(state)) {
    const event = waveEvent(prev, state);
    if (event === 'won') return 'Survived!';
    if (event === 'boss') return 'Boss incoming';
    return event === 'cleared' ? `Wave ${state.level} cleared` : '';
  }
  if (!isGunGame(prev) || !isGunGame(state)) return '';
  if (state.winner || prev.levels !== state.levels) return '';
  if (state.level > prev.level) return `Level ${state.level}: ${state.weapon}`;
  if (state.level < prev.level) {
    return `Down to level ${state.level}: ${state.weapon}`;
  }
  return '';
}

export type WaveEvent = 'cleared' | 'boss' | 'won';

/**
 * What happened in Survival between two states: a wave cleared (the break
 * starts), a boss came, all waves cleared; undefined for nothing.
 */
export function waveEvent(
  prev: ModeState,
  state: ModeState
): WaveEvent | undefined {
  if (state.winner) return prev.winner ? undefined : 'won';
  if (state.weapon === 'Break' && prev.weapon !== 'Break') return 'cleared';
  if (state.weapon === 'Boss' && prev.weapon !== 'Boss') return 'boss';
  return undefined;
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
