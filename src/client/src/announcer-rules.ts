// Announcer rules (C.2), without DOM or audio: which sound a kill, a scores
// snapshot or a game mode change calls for, and which sound wins when they
// overlap. hud.ts feeds the events; announcer.ts plays the result.
import { isGunGame, type ModeState } from './gamemode';
import type { KillEvent, KillResult } from './stats';

/** Files in public/sounds (C.1), each as .webm (Opus) and .mp3. */
export const SOUND_NAMES = [
  'first-blood',
  'headshot',
  'double-kill',
  'triple-kill',
  'quad-kill',
  'rampage',
  'killing-spree',
  'dominating',
  'unstoppable',
  'godlike',
  'humiliation',
  'knifed',
  'last-man',
  'level-up',
  'final-level',
  'winner',
] as const;

export type SoundName = (typeof SOUND_NAMES)[number];

/**
 * Higher wins. The plan's order is winner > godlike/unstoppable >
 * multi-kills > first blood > humiliation > headshot; the sounds it doesn't
 * rank sit next to their closest kin: final level by the top streaks, the
 * lower streaks and last man standing with the multi-kills, knifed and level
 * up with humiliation.
 */
export const SOUND_PRIORITY: Readonly<Record<SoundName, number>> = {
  winner: 6,
  godlike: 5,
  unstoppable: 5,
  'final-level': 5,
  'double-kill': 4,
  'triple-kill': 4,
  'quad-kill': 4,
  rampage: 4,
  'killing-spree': 4,
  dominating: 4,
  'last-man': 4,
  'first-blood': 3,
  humiliation: 2,
  knifed: 2,
  'level-up': 2,
  headshot: 1,
};

/**
 * One sound at a time: next stops the playing sound when its priority is at
 * least as high (a triple kill replaces the double kill still playing), and
 * is dropped when it's lower.
 */
export function shouldReplace(
  playing: SoundName | undefined,
  next: SoundName
): boolean {
  return (
    playing === undefined || SOUND_PRIORITY[next] >= SOUND_PRIORITY[playing]
  );
}

/** The highest priority sound of candidates (the first one on a tie). */
export function pickSound(
  candidates: readonly SoundName[]
): SoundName | undefined {
  let best: SoundName | undefined;
  for (const sound of candidates) {
    if (best === undefined || SOUND_PRIORITY[sound] > SOUND_PRIORITY[best]) {
      best = sound;
    }
  }
  return best;
}

/**
 * What the player can change (C.3 adds them to the Sound settings as
 * announcerVolume, announcerHeadshots, announcerOthers and
 * announcerOtherStreaks).
 */
export type AnnouncerOptions = {
  /** 0-100 %; 0 turns the announcer off. */
  volume: number;
  /** Headshot sounds (can be very frequent). */
  headshots: boolean;
  /** Other players' first blood. */
  others: boolean;
  /** Other players' multi-kills and streaks (sound and toast). */
  otherStreaks: boolean;
};

export const DEFAULT_ANNOUNCER_OPTIONS: Readonly<AnnouncerOptions> = {
  volume: 70,
  headshots: true,
  others: true,
  otherStreaks: true,
};

/** double-kill ... rampage for a multi-kill count (2, 3, 4, 5+). */
export function multiKillSound(count: number): SoundName | undefined {
  if (count < 2) return undefined;
  if (count === 2) return 'double-kill';
  if (count === 3) return 'triple-kill';
  if (count === 4) return 'quad-kill';
  return 'rampage';
}

/** The sound for a streak reaching 5, 10, 15 or 20 (once per threshold). */
export function streakSound(streak: number): SoundName | undefined {
  switch (streak) {
    case 5:
      return 'killing-spree';
    case 10:
      return 'dominating';
    case 15:
      return 'unstoppable';
    case 20:
      return 'godlike';
  }
  return undefined;
}

/** "Killing spree" ... "Godlike" for a streak sound, "" otherwise. */
export function streakLabel(sound: SoundName | undefined): string {
  switch (sound) {
    case 'killing-spree':
      return 'Killing spree';
    case 'dominating':
      return 'Dominating';
    case 'unstoppable':
      return 'Unstoppable';
    case 'godlike':
      return 'Godlike';
  }
  return '';
}

/** The knife's name in kill events (the DeathMsg weapon). */
export const KNIFE = 'knife';

/** A `scores` player, as far as last man standing needs it. */
export type LastManPlayer = {
  team: 'CT' | 'T' | 'SPEC' | '';
  dead: boolean;
  local: boolean;
};

/**
 * True when the local player is alive on a team, at least one teammate is in
 * the game and none is alive, and at least one enemy is alive.
 */
export function isLastMan(players: readonly LastManPlayer[]): boolean {
  const me = players.find((p) => p.local);
  if (!me || me.dead || (me.team !== 'CT' && me.team !== 'T')) return false;
  let teammates = 0;
  let aliveTeammates = 0;
  let aliveEnemies = 0;
  for (const p of players) {
    if (p.local || (p.team !== 'CT' && p.team !== 'T')) continue;
    if (p.team === me.team) {
      teammates++;
      if (!p.dead) aliveTeammates++;
    } else if (!p.dead) {
      aliveEnemies++;
    }
  }
  return teammates > 0 && aliveTeammates === 0 && aliveEnemies > 0;
}

/** The local player has an alive teammate (arms last man standing). */
function hasAliveTeammate(players: readonly LastManPlayer[]): boolean {
  const me = players.find((p) => p.local);
  if (!me || me.dead || (me.team !== 'CT' && me.team !== 'T')) return false;
  return players.some((p) => !p.local && p.team === me.team && !p.dead);
}

/**
 * The sound for a `mode` change from prev to state (Part A): someone won Gun
 * Game, the local player reached the last level, or went up a level.
 */
export function modeSound(
  prev: ModeState | undefined,
  state: ModeState
): SoundName | undefined {
  if (!isGunGame(prev) || !isGunGame(state)) return undefined;
  if (state.winner) return prev.winner ? undefined : 'winner';
  if (prev.levels !== state.levels || state.level <= prev.level) {
    return undefined;
  }
  return state.level === state.levels ? 'final-level' : 'level-up';
}

export type KillCall = {
  /** The sound to play, after the options; undefined for none. */
  sound?: SoundName;
  /** Set on the round's (or map's) first enemy kill: the killer's name. */
  firstBlood?: string;
  /**
   * Another player's multi-kill or streak (with otherStreaks), as toast
   * text: "Walter: Double kill", "Walter: Killing spree · Triple kill".
   */
  otherStreak?: string;
};

export type AnnouncerTriggers = ReturnType<typeof createAnnouncerTriggers>;

/**
 * Per-round state of the triggers. Rounds come from hud.ts (the timer's round
 * start, the reset event); in Gun Game and Deathmatch (setGameMode 1 or 2)
 * round starts are ignored, so first blood and last man count per map.
 *
 * After a reset (map change or joining) in a classic game, first blood waits
 * for the next round start: joining mid-round, the page can't know whether
 * someone already drew it. In Gun Game and Deathmatch it's open right away
 * (a player joining mid-map hears the first kill they see).
 */
export function createAnnouncerTriggers() {
  let gameMode = 0;
  let firstBloodDone = false;
  // Last man standing: armed by a snapshot this round with an alive
  // teammate, so a stale snapshot from the last round can't fire it.
  let lastManArmed = false;
  let lastManDone = false;

  function newRound(): void {
    firstBloodDone = false;
    lastManArmed = false;
    lastManDone = false;
  }

  return {
    /**
     * A counted kill event: result is recordKill's answer for it, localName
     * the local player's name ("" while unknown).
     */
    kill(
      kill: KillEvent,
      result: KillResult,
      localName: string,
      options: Readonly<AnnouncerOptions>
    ): KillCall {
      if (!result.counted || result.kind !== 'kill') return {};
      const call: KillCall = {};
      const candidates: SoundName[] = [];
      const mine = result.local !== undefined;

      if (!firstBloodDone) {
        firstBloodDone = true;
        call.firstBlood = kill.killer;
        if (mine || options.others) candidates.push('first-blood');
      }
      if (result.local) {
        const multi = result.local.multiKill;
        const multiSound = multi && multiKillSound(multi.count);
        if (multiSound) candidates.push(multiSound);
        const streak = streakSound(result.local.streak);
        if (streak) candidates.push(streak);
        if (kill.weapon === KNIFE) candidates.push('humiliation');
        // pickSound keeps it out whenever a multi-kill plays.
        if (kill.headshot && options.headshots) candidates.push('headshot');
      } else if (result.killer && options.otherStreaks) {
        // Only the big moments for other players: no headshot, humiliation.
        const multi = result.killer.multiKill;
        const multiSound = multi && multiKillSound(multi.count);
        const streak = streakSound(result.killer.streak);
        if (multiSound) candidates.push(multiSound);
        if (streak) candidates.push(streak);
        const labels = [streakLabel(streak), multi?.label ?? ''];
        const text = labels.filter(Boolean).join(' · ');
        if (text) call.otherStreak = `${result.killer.name}: ${text}`;
      }
      if (
        !result.local &&
        localName &&
        kill.victim === localName &&
        kill.weapon === KNIFE
      ) {
        candidates.push('knifed');
      }
      call.sound = pickSound(candidates);
      return call;
    },

    /** A scores snapshot: 'last-man' once per round, else undefined. */
    scores(players: readonly LastManPlayer[]): SoundName | undefined {
      if (gameMode !== 0 || lastManDone) return undefined;
      if (hasAliveTeammate(players)) {
        lastManArmed = true;
        return undefined;
      }
      if (!lastManArmed || !isLastMan(players)) return undefined;
      lastManDone = true;
      return 'last-man';
    },

    /** A round started (classic only; ignored in Gun Game / Deathmatch). */
    roundStart(): void {
      if (gameMode === 0) newRound();
    },

    /** wc_gamemode: 0 classic, 1 Gun Game, 2 Deathmatch. A change restarts. */
    setGameMode(mode: number): void {
      if (mode === gameMode) return;
      gameMode = mode;
      newRound();
    },

    gameMode(): number {
      return gameMode;
    },

    /** Map change or reconnect. The game mode is kept until told again. */
    reset(): void {
      newRound();
      firstBloodDone = gameMode === 0;
    },
  };
}
