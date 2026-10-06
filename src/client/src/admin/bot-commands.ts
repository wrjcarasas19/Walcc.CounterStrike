// YaPB console commands for the Bots tab (no DOM, so it can be checked on
// its own). Every command is a fixed string or a checked number; see the
// "0.3 results" section of plans/admin-player-features.md for the names.

export type BotTeam = 'CT' | 'T';

/** yb_difficulty levels, named as in YaPB's own menu. */
export const DIFFICULTIES: readonly { level: number; label: string }[] = [
  { level: 0, label: 'Newbie' },
  { level: 1, label: 'Average' },
  { level: 2, label: 'Normal' },
  { level: 3, label: 'Professional' },
  { level: 4, label: 'Godlike' },
];
/** yb_difficulty in the image's yapb.cfg (YaPB's default). */
export const DEFAULT_DIFFICULTY = 3;

/** The engine's MAX_CLIENTS; YaPB also caps the quota at maxplayers. */
export const BOT_QUOTA_MAX = 32;

export const ADD_BOT_COMMANDS: Record<BotTeam, string> = {
  CT: 'yb add_ct',
  T: 'yb add_t',
};
/** Kicks one bot (a dead one first) and lowers yb_quota by one. */
export const KICK_BOT_COMMAND = 'yb kick';
/** Kicks every bot at once and sets yb_quota to 0. */
export const KICK_ALL_BOTS_COMMAND = 'yb kickall instant';

// Everything the tab can send. Checked again in botCommand, so a mistake in
// this file can't put anything else on the command line.
const COMMAND_PATTERN =
  /^(?:yb (?:add_ct|add_t|kick|kickall instant)|yb_difficulty [0-4]|yb_quota_mode fill|yb_quota (?:[0-9]|[12][0-9]|3[0-2]))$/;
const QUOTA_PATTERN = /^\d{1,2}$/;

function botCommand(command: string): string {
  if (!COMMAND_PATTERN.test(command)) {
    throw new Error(`Not a Bots tab command: ${command}`);
  }
  return command;
}

export function addBotCommand(team: BotTeam): string {
  return botCommand(ADD_BOT_COMMANDS[team]);
}

export function kickBotCommand(): string {
  return botCommand(KICK_BOT_COMMAND);
}

export function kickAllBotsCommand(): string {
  return botCommand(KICK_ALL_BOTS_COMMAND);
}

export function isDifficulty(level: number): boolean {
  return DIFFICULTIES.some((difficulty) => difficulty.level === level);
}

/** `yb_difficulty <level>`; also changes the bots already in the game. */
export function difficultyCommand(level: number): string {
  if (!isDifficulty(level)) throw new Error(`Bad bot difficulty: ${level}`);
  return botCommand(`yb_difficulty ${level}`);
}

/** Parses the "fill to N players" field: a whole number 0..BOT_QUOTA_MAX. */
export function parseBotQuota(
  raw: string
): { ok: true; value: number } | { ok: false; error: string } {
  const text = raw.trim();
  const value = Number(text);
  if (
    !QUOTA_PATTERN.test(text) ||
    !Number.isInteger(value) ||
    value > BOT_QUOTA_MAX
  ) {
    return {
      ok: false,
      error: `Enter a whole number from 0 to ${BOT_QUOTA_MAX}.`,
    };
  }
  return { ok: true, value };
}

/**
 * Keeps `players` players on the server, humans included: bots join or
 * leave as humans leave or join. The mode goes first so the quota is never
 * read as a plain bot count.
 */
export function botQuotaCommands(players: number): string[] {
  if (!Number.isInteger(players) || players < 0 || players > BOT_QUOTA_MAX) {
    throw new Error(`Bad bot quota: ${players}`);
  }
  return [botCommand('yb_quota_mode fill'), botCommand(`yb_quota ${players}`)];
}
