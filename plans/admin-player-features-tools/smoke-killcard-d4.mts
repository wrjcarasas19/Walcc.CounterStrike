// "Killed by" card texts and rules (new-features-1006 D.4). Run from the
// repo root:
//   npx tsx plans/admin-player-features-tools/smoke-killcard-d4.mts
import assert from 'node:assert/strict';
import {
  BOMB_DEATH_WINDOW_MS,
  KILL_CARD_MS,
  STREAK_MIN,
  allTimeDuel,
  allTimeLineText,
  bombCard,
  createBombDeathDetector,
  detailTags,
  detailsText,
  duelUrl,
  hasDuelLines,
  killCardFor,
  mapLineText,
  parseDuel,
  streakText,
  weaponKind,
  weaponLabel,
} from '../../src/client/src/killcard-text.ts';
import type { KillInfo } from '../../src/client/src/killinfo.ts';
import type { KillEvent } from '../../src/client/src/stats.ts';

assert.equal(KILL_CARD_MS, 15000);

function k(
  killer: string,
  victim: string,
  o: Partial<KillEvent> = {}
): KillEvent {
  return {
    killer,
    victim,
    weapon: 'ak47',
    headshot: false,
    killerTeam: 'T',
    victimTeam: 'CT',
    ...o,
  };
}

// Not the local player's death: no card.
assert.equal(killCardFor(k('Walter', 'Other'), 'Me'), undefined);
assert.equal(killCardFor(k('Walter', 'Me'), ''), undefined);
// Object victim (breakable): no card even with the same name.
assert.equal(
  killCardFor(k('Walter', 'Me', { weapon: 'Me', victimTeam: '' }), 'Me'),
  undefined
);

// Enemy kill: full card.
assert.deepEqual(killCardFor(k('Walter', 'Me', { headshot: true }), 'Me'), {
  kind: 'enemy',
  title: 'Killed by',
  killer: 'Walter',
  killerTeam: 'T',
  weapon: 'AK-47',
  weaponKind: 'gun',
  headshot: true,
});
assert.equal(hasDuelLines('enemy'), true);

// Team kill.
const tk = killCardFor(k('Mate', 'Me', { killerTeam: 'CT' }), 'Me')!;
assert.equal(tk.kind, 'teammate');
assert.equal(tk.title, 'Killed by teammate');
assert.equal(tk.killer, 'Mate');
assert.equal(hasDuelLines('teammate'), false);

// Knife and grenade kills by a player.
assert.equal(
  killCardFor(k('W', 'Me', { weapon: 'knife' }), 'Me')!.weaponKind,
  'knife'
);
const he = killCardFor(k('W', 'Me', { weapon: 'grenade' }), 'Me')!;
assert.equal(he.weapon, 'HE Grenade');
assert.equal(he.weaponKind, 'grenade');

// World and self deaths: short cards, no killer, no duel lines.
const short = (o: Partial<KillEvent>, killer = '') =>
  killCardFor(k(killer, 'Me', { killerTeam: '', ...o }), 'Me')!;
assert.equal(short({ weapon: 'worldspawn' }).title, 'You fell to your death');
assert.equal(short({ weapon: 'worldspawn' }).kind, 'fall');
assert.equal(short({ weapon: 'world' }).title, 'You killed yourself');
assert.equal(short({ weapon: 'world' }, 'Me').kind, 'self');
assert.equal(short({ weapon: '' }).kind, 'self');
assert.equal(
  short({ weapon: 'grenade' }, 'Me').title,
  'Killed by your own grenade'
);
assert.equal(short({ weapon: 'trigger_hurt' }).title, 'Killed by the map');
for (const o of [{ weapon: 'worldspawn' }, { weapon: 'world' }]) {
  const card = short(o);
  assert.equal(card.killer, '');
  assert.equal(card.weapon, '');
  assert.equal(hasDuelLines(card.kind), false);
}
assert.equal(bombCard().title, 'Killed by the bomb');
assert.equal(hasDuelLines('bomb'), false);

// Weapons.
assert.equal(weaponLabel('m4a1'), 'M4A1');
assert.equal(weaponLabel('unknownthing'), 'unknownthing');
assert.equal(weaponKind(''), '');
assert.equal(weaponKind('awp'), 'gun');
assert.equal(weaponKind('hegrenade'), 'grenade');

// Details from killinfo.
const info: KillInfo = {
  killerUserid: 7,
  health: 87,
  armor: 100,
  weapon: 'ak47',
  headshot: true,
  blind: false,
  wall: false,
  distance: 23,
};
assert.equal(detailsText(info), '87 HP · 100 armour · 23 m');
assert.equal(detailsText({ ...info, health: 0 }), 'Killer already dead · 23 m');
assert.deepEqual(detailTags(info), []);
assert.deepEqual(detailTags({ ...info, wall: true, blind: true }), [
  'Through a wall',
  'Killer was blind',
]);

// Duel lines.
assert.equal(
  mapLineText({ aKills: 2, bKills: 5 }, 'Walter'),
  'This map: you 2 – 5 Walter'
);
assert.equal(allTimeLineText({ aKills: 14, bKills: 22 }), 'All time: 14 – 22');
assert.equal(streakText('Walter', undefined), '');
assert.equal(streakText('Walter', STREAK_MIN - 1), '');
assert.equal(streakText('Walter', 6), 'Walter is on a 6 kill streak');

// All time: server + map kills since the fetch; none without history.
assert.equal(
  allTimeDuel(
    { aKills: 0, bKills: 0 },
    { aKills: 0, bKills: 0 },
    { aKills: 1, bKills: 2 }
  ),
  undefined
);
assert.deepEqual(
  allTimeDuel(
    { aKills: 14, bKills: 21 },
    { aKills: 1, bKills: 2 },
    { aKills: 1, bKills: 3 }
  ),
  { aKills: 14, bKills: 22 }
);
assert.deepEqual(
  // Nothing from before this map (the server only has this map's kills,
  // e.g. after the settle fetch): no line.
  allTimeDuel(
    { aKills: 1, bKills: 3 },
    { aKills: 1, bKills: 3 },
    { aKills: 1, bKills: 4 }
  ),
  undefined
);
assert.deepEqual(
  allTimeDuel(
    { aKills: 3, bKills: 4 },
    { aKills: 2, bKills: 2 },
    { aKills: 0, bKills: 0 }
  ),
  { aKills: 3, bKills: 4 }
);
assert.deepEqual(parseDuel({ aKills: 3, bKills: 4 }), { aKills: 3, bKills: 4 });
assert.equal(parseDuel({ aKills: 3 }), undefined);
assert.equal(parseDuel(null), undefined);
assert.equal(parseDuel({ aKills: -1, bKills: 2 }), undefined);
assert.equal(
  duelUrl('Me & you', 'Wal/ter?'),
  '/duel?a=Me%20%26%20you&b=Wal%2Fter%3F'
);

// Bomb deaths: an unexplained death and a bomb round end, either order.
{
  const d = createBombDeathDetector();
  assert.equal(d.died(1000), false);
  assert.equal(d.round('bomb', 1200), true);
  // Used up.
  assert.equal(d.round('bomb', 1300), false);
}
{
  const d = createBombDeathDetector();
  assert.equal(d.round('bomb', 1000), false);
  assert.equal(d.died(1100), true);
  assert.equal(d.died(1150), false);
}
{
  // Killed by a player just before: not the bomb.
  const d = createBombDeathDetector();
  d.killed(1000);
  assert.equal(d.died(1010), false);
  assert.equal(d.round('bomb', 1050), false);
}
{
  // Kill event right after the alive change clears it.
  const d = createBombDeathDetector();
  assert.equal(d.died(1000), false);
  d.killed(1005);
  assert.equal(d.round('bomb', 1050), false);
}
{
  // Other round ends and late ones don't count.
  const d = createBombDeathDetector();
  assert.equal(d.died(1000), false);
  assert.equal(d.round('elimination', 1100), false);
  assert.equal(d.round('bomb', 1000 + BOMB_DEATH_WINDOW_MS + 1), false);
  d.reset();
  assert.equal(d.round('bomb', 5000), false);
  d.reset();
  assert.equal(d.died(5100), false);
}

console.log('smoke-killcard-d4: ok');
