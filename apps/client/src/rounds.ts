// Round and map summary logic (6.2), without DOM: round end texts, round
// start detection, round MVP and the map summary rows. hud.ts draws them.
import type { PlayerStats } from './stats';

export type RoundWinner = 'CT' | 'T' | '';

/** Stable round end reasons sent by the bridge (see web_bridge.h). */
export type RoundReason =
  | 'elimination'
  | 'bomb'
  | 'defuse'
  | 'time'
  | 'hostages'
  | 'vip_escaped'
  | 'vip_killed'
  | 'escaped'
  | 'escape_prevented'
  | 'draw'
  | 'commencing';

/** Payload of the bridge's `round` event (cs16-client 0.0.7+). */
export type RoundEnd = {
  winner: RoundWinner;
  reason: RoundReason;
  /** The raw round end title, e.g. "#Target_Saved". */
  message: string;
  /** Rounds won, null before the first TeamScore of the map. */
  ctScore: number | null;
  tScore: number | null;
};

/** Payload of the bridge's `intermission` event (cs16-client 0.0.7+). */
export type Intermission = { active: boolean; map: string };

/** A scores player, as far as the summary needs it. */
export type SummaryPlayer = {
  name: string;
  team: 'CT' | 'T' | 'SPEC' | '';
  frags: number;
  deaths: number;
  bot: boolean;
  local: boolean;
};

export type SummaryRow = {
  name: string;
  team: 'CT' | 'T' | 'SPEC' | '';
  local: boolean;
  bot: boolean;
  /** Server score for the whole map; null for players who left. */
  frags: number | null;
  /** Session counters (since the page joined), zero without an entry. */
  kills: number;
  deaths: number;
  headshots: number;
  bestStreak: number;
};

export const TEAM_NAMES = { CT: 'Counter-Terrorists', T: 'Terrorists' };

/**
 * A `timer` event whose seconds go up by more than this starts a new round
 * (the RoundTime message at round start or freeze time end). Smaller steps
 * up are resync jitter.
 */
export const ROUND_START_JUMP = 2;

const REASON_TEXT: Record<RoundReason, string> = {
  elimination: 'Enemy team eliminated',
  bomb: 'Target bombed',
  defuse: 'Bomb defused',
  time: 'Time ran out',
  hostages: 'All hostages rescued',
  vip_escaped: 'The VIP escaped',
  vip_killed: 'The VIP was assassinated',
  escaped: 'The Terrorists escaped',
  escape_prevented: 'The escape was prevented',
  draw: '',
  commencing: '',
};

/** More precise texts for the "time" endings, by title. */
const TIME_TEXT: Record<string, string> = {
  '#Target_Saved': 'Target saved',
  '#Hostages_Not_Rescued': 'Hostages not rescued',
  '#VIP_Not_Escaped': 'The VIP did not escape',
  '#Terrorists_Not_Escaped': 'The Terrorists did not escape',
};

/** Banner headline: "Counter-Terrorists win", "Round draw"... */
export function roundTitle(end: RoundEnd): string {
  if (end.reason === 'commencing') return 'Game commencing';
  if (end.winner === 'CT' || end.winner === 'T') {
    return `${TEAM_NAMES[end.winner]} win`;
  }
  return 'Round draw';
}

/** Banner sub line: why the round ended, "" when there's nothing to add. */
export function roundReasonText(end: RoundEnd): string {
  if (end.reason === 'time' && TIME_TEXT[end.message]) {
    return TIME_TEXT[end.message];
  }
  return REASON_TEXT[end.reason] ?? '';
}

/** "CT 3 : 5 T", or "" while the team scores aren't known. */
export function roundScoreText(end: RoundEnd): string {
  if (end.ctScore === null || end.tScore === null) return '';
  return `CT ${end.ctScore} : ${end.tScore} T`;
}

function betterThan(
  a: { kills: number; headshots: number; deaths: number },
  b: { kills: number; headshots: number; deaths: number }
): boolean {
  if (a.kills !== b.kills) return a.kills > b.kills;
  if (a.headshots !== b.headshots) return a.headshots > b.headshots;
  return a.deaths < b.deaths;
}

/**
 * The player with the most enemy kills this round (ties: more headshots,
 * then fewer deaths, then the first by name); undefined if nobody killed.
 */
export function pickRoundMvp(
  players: readonly PlayerStats[]
): PlayerStats | undefined {
  let best: PlayerStats | undefined;
  for (const player of [...players].sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (player.round.kills === 0) continue;
    if (!best || betterThan(player.round, best.round)) best = player;
  }
  return best;
}

/** The same over the whole session: the map summary's MVP. */
export function pickMapMvp(
  players: readonly PlayerStats[]
): PlayerStats | undefined {
  let best: PlayerStats | undefined;
  for (const player of [...players].sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (player.kills === 0) continue;
    if (!best || betterThan(player, best)) best = player;
  }
  return best;
}

/** "3 kills", "1 kill". */
export function killsText(kills: number): string {
  return `${kills} ${kills === 1 ? 'kill' : 'kills'}`;
}

/**
 * Spots round starts in the `timer` events: the countdown only goes down,
 * so a jump up is a new RoundTime (round start, or freeze time end, when no
 * kill can happen yet). Kills after the round end message still belong to
 * the old round until then.
 */
export function createRoundStartDetector(jump = ROUND_START_JUMP) {
  let last: number | undefined;
  return {
    /** Returns true when seconds start a new round. */
    timer(seconds: number): boolean {
      const started = last !== undefined && seconds - last > jump;
      last = seconds;
      return started;
    },
    reset(): void {
      last = undefined;
    },
  };
}

const TEAM_ORDER: Record<SummaryRow['team'], number> = {
  CT: 0,
  T: 1,
  SPEC: 2,
  '': 3,
};

/**
 * One row per player for the map summary: everyone in the last scores
 * snapshot, plus players with session stats who have left (team "",
 * frags null). Sorted by team (CT, T, spectators, left), then server score,
 * then session kills, then name.
 */
export function summaryRows(
  players: readonly SummaryPlayer[],
  stats: readonly PlayerStats[]
): SummaryRow[] {
  const byName = new Map(stats.map((s) => [s.name, s]));
  const rows: SummaryRow[] = players.map((p) => {
    const s = byName.get(p.name);
    byName.delete(p.name);
    return {
      name: p.name,
      team: p.team,
      local: p.local,
      bot: p.bot,
      frags: p.frags,
      kills: s?.kills ?? 0,
      deaths: s?.deaths ?? 0,
      headshots: s?.headshots ?? 0,
      bestStreak: s?.bestStreak ?? 0,
    };
  });
  for (const s of byName.values()) {
    if (s.kills === 0 && s.deaths === 0 && s.teamKills === 0) continue;
    rows.push({
      name: s.name,
      team: '',
      local: false,
      bot: false,
      frags: null,
      kills: s.kills,
      deaths: s.deaths,
      headshots: s.headshots,
      bestStreak: s.bestStreak,
    });
  }
  return rows.sort(
    (a, b) =>
      TEAM_ORDER[a.team] - TEAM_ORDER[b.team] ||
      (b.frags ?? -1) - (a.frags ?? -1) ||
      b.kills - a.kills ||
      a.name.localeCompare(b.name)
  );
}

/** Map result line from the team scores: "Terrorists win the map 8 : 5". */
export function mapResultText(ct: number, t: number): string {
  if (ct === t) return `Draw ${ct} : ${t}`;
  const winner = ct > t ? TEAM_NAMES.CT : TEAM_NAMES.T;
  return `${winner} win the map ${Math.max(ct, t)} : ${Math.min(ct, t)}`;
}
