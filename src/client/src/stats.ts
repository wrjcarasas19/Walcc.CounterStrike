// Session stats counted from the HUD bridge's kill events (no DOM, so it can
// be tested with node). hud.ts feeds it and shows the result.
//
// Players are keyed by name: the kill event only carries names (cs16-client
// death.cpp sends g_PlayerInfoList[slot].name, not the slot). The server keeps
// the names of connected players unique, so a name is unambiguous when the
// kill happens. Renames are followed through scores snapshots, which have the
// userid (unique per connection): a userid seen under a new name moves (or
// merges) the old name's stats. Someone who leaves and reconnects keeps their
// stats under the same name; a new player who takes a departed player's name
// inherits them (rare, and a session view rather than a ranked one).

export type Team = 'CT' | 'T' | '';

export type KillEvent = {
  killer: string;
  victim: string;
  weapon: string;
  headshot: boolean;
  killerTeam: Team;
  victimTeam: Team;
  /**
   * Server userids of the killer and victim (cs16-client 0.0.7+), 0 when
   * there is no such player. Used to follow renames between scores
   * snapshots.
   */
  killerUserid?: number;
  victimUserid?: number;
};

/** Counters for a period (the whole session, or the current round). */
export type Counters = {
  /** Enemy kills; team kills are not included. */
  kills: number;
  deaths: number;
  /** Enemy kills that were headshots. */
  headshots: number;
  teamKills: number;
  /** Deaths with no killer: suicide, fall, world. Included in deaths. */
  suicides: number;
};

export type PlayerStats = Counters & {
  name: string;
  /** Enemy kills since the last death. */
  streak: number;
  bestStreak: number;
  /** Counters since the last startRound() (or reset). */
  round: Counters;
};

export type MultiKill = { count: number; label: string };

export type KillResult = {
  /** False when the event was ignored (non-player victim, no victim). */
  counted: boolean;
  kind?: 'kill' | 'teamkill' | 'suicide';
  /** Set on every enemy kill: the killer's streak and multi-kill. */
  killer?: KillerResult;
  /** Set when the local player made an enemy kill (same values as killer). */
  local?: KillerResult;
};

export type KillerResult = {
  name: string;
  streak: number;
  multiKill?: MultiKill;
};

/** What the stats need from a `scores` player. */
export type ScoreIdentity = { userid?: number; name: string; local: boolean };

/**
 * Kills by one player at most this far apart (from one kill to the
 * next) form one multi-kill: two make a double kill, three a triple kill...
 */
export const MULTI_KILL_WINDOW_MS = 4_000;

const MULTI_KILL_LABELS = [
  '',
  '',
  'Double kill',
  'Triple kill',
  'Quad kill',
  'Penta kill',
];

export function multiKillLabel(count: number): string {
  if (count < 2) return '';
  return MULTI_KILL_LABELS[count] ?? 'Rampage';
}

function zero(): Counters {
  return { kills: 0, deaths: 0, headshots: 0, teamKills: 0, suicides: 0 };
}

function blank(name: string): PlayerStats {
  return { name, ...zero(), streak: 0, bestStreak: 0, round: zero() };
}

function addCounters(into: Counters, from: Counters): void {
  into.kills += from.kills;
  into.deaths += from.deaths;
  into.headshots += from.headshots;
  into.teamKills += from.teamKills;
  into.suicides += from.suicides;
}

function copy(stats: PlayerStats): PlayerStats {
  return { ...stats, round: { ...stats.round } };
}

/** Kills per death, as text: "1.50"; kills alone with no deaths. */
export function formatKd(stats: Counters): string {
  return (stats.kills / Math.max(1, stats.deaths)).toFixed(2);
}

/** Headshot share of enemy kills, e.g. "43%"; "-" before the first kill. */
export function formatHeadshots(
  stats: Pick<Counters, 'kills' | 'headshots'>
): string {
  if (stats.kills === 0) return '-';
  return `${Math.round((stats.headshots / stats.kills) * 100)}%`;
}

/** Head-to-head enemy kills between two players (this map). */
export type Duel = { aKills: number; bKills: number };

export type SessionStats = ReturnType<typeof createSessionStats>;

export function createSessionStats(windowMs = MULTI_KILL_WINDOW_MS) {
  const players = new Map<string, PlayerStats>();
  // killer -> victim -> enemy kills of killer on victim. Team kills and
  // suicides are not counted, like the kills column and the leaderboard.
  const duels = new Map<string, Map<string, number>>();
  // userid -> name in the last scores snapshot that had it.
  const names = new Map<number, string>();
  let localName = '';
  // killer -> their last enemy kill (performance.now()) and the multi-kill
  // count it ended. Not reset by the killer's death: a grenade thrown just
  // before dying still adds to the multi-kill.
  const multiKills = new Map<string, { last: number; count: number }>();

  function entry(name: string): PlayerStats {
    let stats = players.get(name);
    if (!stats) {
      stats = blank(name);
      players.set(name, stats);
    }
    return stats;
  }

  function died(victim: PlayerStats, suicide: boolean): void {
    victim.deaths += 1;
    victim.round.deaths += 1;
    if (suicide) {
      victim.suicides += 1;
      victim.round.suicides += 1;
    }
    victim.streak = 0;
  }

  function get(name: string): PlayerStats | undefined {
    const stats = players.get(name);
    return stats && copy(stats);
  }

  function addDuelKills(killer: string, victim: string, kills: number): void {
    if (killer === victim || kills <= 0) return;
    let row = duels.get(killer);
    if (!row) {
      row = new Map();
      duels.set(killer, row);
    }
    row.set(victim, (row.get(victim) ?? 0) + kills);
  }

  /** Moves (or merges) from's pairs, as killer and as victim, to to. */
  function renameDuels(from: string, to: string): void {
    const own = duels.get(from);
    if (own) {
      duels.delete(from);
      for (const [victim, kills] of own) {
        addDuelKills(to, victim, kills);
      }
    }
    for (const [killer, row] of [...duels]) {
      const kills = row.get(from);
      if (kills === undefined) continue;
      row.delete(from);
      // A pair between the two merged names would be a player against
      // themself: dropped.
      addDuelKills(killer, to, kills);
      if (row.size === 0) duels.delete(killer);
    }
  }

  function rename(from: string, to: string): void {
    if (from === to) return;
    if (localName === from) localName = to;
    renameDuels(from, to);
    const chain = multiKills.get(from);
    if (chain) {
      multiKills.delete(from);
      if (!multiKills.has(to)) multiKills.set(to, chain);
    }
    const old = players.get(from);
    if (!old) return;
    players.delete(from);
    const current = players.get(to);
    if (!current) {
      old.name = to;
      players.set(to, old);
      return;
    }
    // Kills already counted under the new name: add the old ones. The new
    // name's streak is the live one.
    addCounters(current, old);
    addCounters(current.round, old.round);
    current.bestStreak = Math.max(current.bestStreak, old.bestStreak);
  }

  /** Records that userid now has name, following a rename. */
  function learn(userid: number | undefined, name: string): void {
    if (!userid || !name) return;
    const previous = names.get(userid);
    if (previous !== undefined) rename(previous, name);
    names.set(userid, name);
  }

  return {
    /**
     * Counts one kill event. now is a millisecond clock (performance.now())
     * used for multi-kills.
     */
    recordKill(kill: KillEvent, now: number): KillResult {
      // A non-player victim (an object) has the object's name and no team.
      if (!kill.victim) return { counted: false };
      if (!kill.victimTeam && kill.victim === kill.weapon) {
        return { counted: false };
      }
      learn(kill.victimUserid, kill.victim);
      if (kill.killer) learn(kill.killerUserid, kill.killer);
      const victim = entry(kill.victim);
      // The bridge sends "" for suicides and world kills (fall damage...).
      if (!kill.killer || kill.killer === kill.victim) {
        died(victim, true);
        return { counted: true, kind: 'suicide' };
      }
      const killer = entry(kill.killer);
      if (kill.killerTeam !== '' && kill.killerTeam === kill.victimTeam) {
        killer.teamKills += 1;
        killer.round.teamKills += 1;
        died(victim, false);
        return { counted: true, kind: 'teamkill' };
      }
      killer.kills += 1;
      killer.round.kills += 1;
      if (kill.headshot) {
        killer.headshots += 1;
        killer.round.headshots += 1;
      }
      killer.streak += 1;
      killer.bestStreak = Math.max(killer.bestStreak, killer.streak);
      addDuelKills(kill.killer, kill.victim, 1);
      died(victim, false);

      const chain = multiKills.get(kill.killer);
      const count = chain && now - chain.last <= windowMs ? chain.count + 1 : 1;
      multiKills.set(kill.killer, { last: now, count });
      const killerResult: KillerResult = {
        name: kill.killer,
        streak: killer.streak,
      };
      if (count >= 2) {
        killerResult.multiKill = { count, label: multiKillLabel(count) };
      }
      const result: KillResult = {
        counted: true,
        kind: 'kill',
        killer: killerResult,
      };
      if (localName && kill.killer === localName) result.local = killerResult;
      return result;
    },

    /** Sets the local player's name (the name used to connect). */
    setLocalName(name: string): void {
      localName = name;
    },

    localName(): string {
      return localName;
    },

    /**
     * Follows renames and the local player's name from a scores snapshot.
     * Players without a userid (older client builds) are skipped.
     */
    updatePlayers(list: readonly ScoreIdentity[]): void {
      for (const player of list) {
        if (player.local) localName = player.name;
        if (!player.userid) continue;
        const previous = names.get(player.userid);
        if (previous !== undefined) rename(previous, player.name);
        names.set(player.userid, player.name);
      }
    },

    /**
     * Player stats as a copy; get(name)?.streak is the player's current
     * kill streak (enemy kills since their last death).
     */
    get,

    /**
     * Enemy kills of a on b and of b on a since the last reset (this map).
     * Team kills don't count. Zero for unknown names.
     */
    duel(a: string, b: string): Duel {
      return {
        aKills: duels.get(a)?.get(b) ?? 0,
        bKills: duels.get(b)?.get(a) ?? 0,
      };
    },

    /**
     * The local player's stats (all zero before its first kill or death);
     * undefined while its name isn't known.
     */
    local(): PlayerStats | undefined {
      if (!localName) return undefined;
      return get(localName) ?? blank(localName);
    },

    /** Every player with an entry, as copies. */
    all(): PlayerStats[] {
      return [...players.values()].map(copy);
    },

    /** Zeroes every player's round counters (streaks carry over). */
    startRound(): void {
      for (const stats of players.values()) stats.round = zero();
    },

    /**
     * Forgets all counters (map change, reconnect). The local name and the
     * userid -> name map are kept: the same connections go on.
     */
    reset(): void {
      players.clear();
      duels.clear();
      multiKills.clear();
    },
  };
}
