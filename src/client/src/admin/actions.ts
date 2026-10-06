import {
  addBotCommand,
  botQuotaCommands,
  difficultyCommand,
  kickAllBotsCommand,
  kickBotCommand,
  type BotTeam,
} from './bot-commands';
import { CVARS, cvarCommand, type CvarName } from './cvars';
import {
  aliasCommands,
  centerCommand,
  chatCommand,
  type MessageColor,
} from '../message-text';

// The typed actions the tabs send. With the admin API (ADMIN_PASSWORD set
// on the server) they go to POST /admin/command as JSON and the server
// builds the commands (src/server/admin_actions.go, which checks every
// value again with the same rules); otherwise actionCommands turns them
// into rcon commands here. No DOM here, so it can be checked on its own.
//
// To add an action, add it here and to adminActions in admin_actions.go.

export type AdminAction =
  | { action: 'changelevel'; map: string }
  | { action: 'set_nextmap'; map: string }
  | { action: 'votemap'; maps: readonly string[] }
  | { action: 'cvar'; name: CvarName; value: number }
  | { action: 'restart' }
  | { action: 'kick'; userid: number }
  | { action: 'say'; text: string }
  | { action: 'csay'; text: string; color: MessageColor }
  | { action: 'bot_add'; team: BotTeam }
  | { action: 'bot_kick' }
  | { action: 'bot_kick_all' }
  | { action: 'bot_difficulty'; level: number }
  | { action: 'bot_quota'; players: number };

export const MAP_PATTERN = /^[A-Za-z0-9_.-]+$/;
/**
 * The longest map name AMX Mod X keeps (32-cell buffers in amx_votemap and
 * nextmap.amxx); longer names can't be voted on or set as the next map.
 */
export const AMXX_MAP_NAME_MAX = 31;
/** amx_votemap takes at most 4 maps. */
export const VOTE_MAPS_MAX = 4;
const USERID_MAX = 2 ** 31 - 1;

/**
 * The rcon commands for an action, in order. Throws if a value is invalid,
 * so it also checks an action before it goes to the API.
 */
export function actionCommands(action: AdminAction): readonly string[] {
  switch (action.action) {
    case 'changelevel':
      if (!MAP_PATTERN.test(action.map)) {
        throw new Error(`Not a map name: ${action.map}`);
      }
      return [`changelevel ${action.map}`];
    case 'set_nextmap':
      checkAmxxMap(action.map);
      // amx_nextmap is FCVAR_SPONLY: Xash3D won't set it from the console,
      // AMX Mod X's amx_cvar can. Pausing mapchooser keeps the players'
      // end-of-map vote from replacing it (until the next map).
      return [
        `amx_cvar amx_nextmap ${action.map}`,
        'amxx pause mapchooser.amxx',
      ];
    case 'votemap':
      if (
        action.maps.length < 1 ||
        action.maps.length > VOTE_MAPS_MAX ||
        new Set(action.maps).size !== action.maps.length
      ) {
        throw new Error(`Bad vote: ${action.maps.join(' ')}`);
      }
      action.maps.forEach(checkAmxxMap);
      return [`amx_votemap ${action.maps.join(' ')}`];
    case 'cvar':
      return [cvarCommand(CVARS[action.name], action.value)];
    case 'restart':
      return ['sv_restart 1'];
    case 'kick':
      if (
        !Number.isInteger(action.userid) ||
        action.userid < 1 ||
        action.userid > USERID_MAX
      ) {
        throw new Error(`Bad userid: ${action.userid}`);
      }
      return [`kick #${action.userid}`];
    case 'say':
      return aliasCommands(chatCommand(action.text));
    case 'csay':
      return aliasCommands(centerCommand(action.text, action.color));
    case 'bot_add':
      return [addBotCommand(action.team)];
    case 'bot_kick':
      return [kickBotCommand()];
    case 'bot_kick_all':
      return [kickAllBotsCommand()];
    case 'bot_difficulty':
      return [difficultyCommand(action.level)];
    case 'bot_quota':
      return botQuotaCommands(action.players);
  }
}

/** True if map can be set as the next map or put in a vote. */
export function isAmxxMap(map: string): boolean {
  return MAP_PATTERN.test(map) && map.length <= AMXX_MAP_NAME_MAX;
}

function checkAmxxMap(map: string): void {
  if (!isAmxxMap(map)) throw new Error(`Not a map name: ${map}`);
}

/** A banned address, as the admin API lists it (banEntry in bans.go). */
export type BanEntry = { address: string; name: string; bannedAt: string };

/**
 * Actions only the admin API has: bans are kept by the Go server, by the
 * player's real address, which rcon can't reach (src/server/admin_bans.go);
 * nextmap reads amx_nextmap, and only the API gets the engine's answer
 * (src/server/admin_maps.go).
 */
export type ApiOnlyAction =
  | { action: 'bans' }
  | { action: 'nextmap' }
  | { action: 'ban'; userid: number; slot: number }
  | { action: 'unban'; address: string };

// An IPv4 address or an IPv6 /64, as the server lists them.
const BAN_ADDRESS_PATTERN = /^(?:[0-9.]{7,15}|[0-9a-f:]{2,39}\/64)$/;
const SLOT_MAX = 64;

/** Throws if a value of an API-only action is invalid. */
export function checkApiOnlyAction(action: ApiOnlyAction): void {
  switch (action.action) {
    case 'bans':
    case 'nextmap':
      return;
    case 'ban':
      checkWhole('userid', action.userid, 1, USERID_MAX);
      checkWhole('slot', action.slot, 1, SLOT_MAX);
      return;
    case 'unban':
      if (!BAN_ADDRESS_PATTERN.test(action.address)) {
        throw new Error(`Not a banned address: ${action.address}`);
      }
      return;
  }
}

function checkWhole(name: string, value: number, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Bad ${name}: ${value}`);
  }
}
