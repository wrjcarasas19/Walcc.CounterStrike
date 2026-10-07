// Kill details from the server (new-features-1006 D.1). Run from the repo
// root:
//   npx tsx plans/admin-player-features-tools/smoke-killinfo-d1.mts
// (or node --experimental-strip-types --import ./ts-ext.mjs on Node 22+).
import assert from 'node:assert/strict';
import {
  KILLINFO_EVENT_CLIENT_VERSION,
  killInfoMatches,
  killInfoSupported,
  parseKillInfo,
} from '../../src/client/src/killinfo.ts';
import { MODE_EVENT_CLIENT_VERSION } from '../../src/client/src/gamemode.ts';
import type { KillEvent } from '../../src/client/src/stats.ts';

// Version gate: same release as the `mode` event; nothing on 0.0.9.
assert.equal(KILLINFO_EVENT_CLIENT_VERSION, MODE_EVENT_CLIENT_VERSION);
assert.equal(killInfoSupported('0.0.9'), false);
assert.equal(killInfoSupported('0.0.10'), true);
assert.equal(killInfoSupported('0.0.11'), true);
assert.equal(killInfoSupported('0.1.0'), true);
assert.equal(killInfoSupported('0.0.10+commit.abc'), true);
assert.equal(killInfoSupported(''), false);

// A full payload as the bridge sends it (JSON booleans).
const full = {
  killerUserid: 7,
  health: 87,
  armor: 100,
  weapon: 'ak47',
  headshot: true,
  blind: false,
  wall: true,
  distance: 23,
};
assert.deepEqual(parseKillInfo(full), full);

// Flags as numbers (a bridge writing the message bytes as-is).
assert.deepEqual(parseKillInfo({ ...full, headshot: 0, blind: 1, wall: 0 }), {
  ...full,
  headshot: false,
  blind: true,
  wall: false,
});

// Missing / bad fields: 0, "" and false; never negative or fractional.
assert.deepEqual(
  parseKillInfo({
    killerUserid: 3,
    health: -5,
    armor: 'x',
    distance: 12.6,
    headshot: 'yes',
  }),
  {
    killerUserid: 3,
    health: 0,
    armor: 0,
    weapon: '',
    headshot: false,
    blind: false,
    wall: false,
    distance: 13,
  }
);
// Killer already dead (a grenade thrown before dying): health 0 kept.
assert.equal(parseKillInfo({ ...full, health: 0 })?.health, 0);

// Nothing to match it to without a killer userid.
assert.equal(parseKillInfo(undefined), undefined);
assert.equal(parseKillInfo(null), undefined);
assert.equal(parseKillInfo({}), undefined);
assert.equal(parseKillInfo({ ...full, killerUserid: 0 }), undefined);
assert.equal(parseKillInfo({ ...full, killerUserid: '7' }), undefined);
assert.equal(parseKillInfo('junk'), undefined);

// Matching the `kill` event it follows.
const kill: KillEvent = {
  killer: 'Walter',
  victim: 'Me',
  weapon: 'ak47',
  headshot: true,
  killerTeam: 'T',
  victimTeam: 'CT',
  killerUserid: 7,
  victimUserid: 2,
};
const info = parseKillInfo(full)!;
assert.equal(killInfoMatches(kill, info), true);
assert.equal(killInfoMatches({ ...kill, killerUserid: 8 }, info), false);
assert.equal(killInfoMatches({ ...kill, weapon: 'knife' }, info), false);
// cs16-client before 0.0.7: no userids, never matches.
const { killerUserid: _k, victimUserid: _v, ...oldKill } = kill;
assert.equal(killInfoMatches(oldKill, info), false);

console.log('smoke-killinfo-d1: all passed');
