// Announcer rules (new-features-1006 C.2). Run from the repo root:
//   npx tsx plans/admin-player-features-tools/smoke-announcer-c2.mts
// (or node --experimental-strip-types --import ./ts-ext.mjs on Node 22+).
import assert from 'node:assert/strict';
import {
  createAnnouncerTriggers,
  DEFAULT_ANNOUNCER_OPTIONS,
  isLastMan,
  modeSound,
  multiKillSound,
  pickSound,
  shouldReplace,
  SOUND_NAMES,
  SOUND_PRIORITY,
  streakSound,
} from '../../src/client/src/announcer-rules.ts';
import { parseModeState } from '../../src/client/src/gamemode.ts';
import {
  createSessionStats,
  MULTI_KILL_WINDOW_MS,
} from '../../src/client/src/stats.ts';
import { readdirSync } from 'node:fs';

// Every sound has both files (C.1).
const files = new Set(readdirSync('src/client/public/sounds'));
for (const name of SOUND_NAMES) {
  assert.ok(files.has(`${name}.webm`), `${name}.webm`);
  assert.ok(files.has(`${name}.mp3`), `${name}.mp3`);
}

// Priority: winner > godlike/unstoppable > multi-kills > first blood >
// humiliation > headshot.
const order = [
  'winner',
  'godlike',
  'double-kill',
  'first-blood',
  'humiliation',
  'headshot',
] as const;
for (let i = 1; i < order.length; i++) {
  assert.ok(SOUND_PRIORITY[order[i - 1]] > SOUND_PRIORITY[order[i]], order[i]);
}
assert.equal(SOUND_PRIORITY.unstoppable, SOUND_PRIORITY.godlike);
for (const m of ['triple-kill', 'quad-kill', 'rampage'] as const) {
  assert.equal(SOUND_PRIORITY[m], SOUND_PRIORITY['double-kill']);
}
assert.equal(shouldReplace(undefined, 'headshot'), true);
assert.equal(shouldReplace('headshot', 'first-blood'), true);
assert.equal(shouldReplace('first-blood', 'headshot'), false, 'lower dropped');
assert.equal(shouldReplace('double-kill', 'triple-kill'), true, 'same level');
assert.equal(shouldReplace('winner', 'godlike'), false);
assert.equal(pickSound([]), undefined);
assert.equal(pickSound(['headshot', 'double-kill']), 'double-kill');
assert.equal(
  pickSound(['headshot', 'first-blood', 'humiliation']),
  'first-blood'
);

assert.equal(multiKillSound(1), undefined);
assert.equal(multiKillSound(2), 'double-kill');
assert.equal(multiKillSound(3), 'triple-kill');
assert.equal(multiKillSound(4), 'quad-kill');
assert.equal(multiKillSound(5), 'rampage');
assert.equal(multiKillSound(9), 'rampage');
assert.deepEqual([4, 5, 6, 10, 11, 15, 20, 21, 25].map(streakSound), [
  undefined,
  'killing-spree',
  undefined,
  'dominating',
  undefined,
  'unstoppable',
  'godlike',
  undefined,
  undefined,
]);

// Kill triggers, fed by the real session stats like hud.ts does.
const opts = DEFAULT_ANNOUNCER_OPTIONS;
const k = (killer: string, victim: string, o: any = {}) => ({
  killer,
  victim,
  weapon: o.weapon ?? 'ak47',
  headshot: !!o.hs,
  killerTeam: o.kt ?? 'CT',
  victimTeam: o.vt ?? 'T',
});
const stats = createSessionStats();
stats.setLocalName('Me');
const t = createAnnouncerTriggers();
let now = 0;
function kill(e: ReturnType<typeof k>, options = opts, dt = 10_000) {
  now += dt;
  return t.kill(e, stats.recordKill(e as any, now), 'Me', options);
}

// Joined mid-round (classic): no first blood until a round starts.
t.reset();
assert.deepEqual(kill(k('Bob', 'Ann', { kt: 'T', vt: 'CT' })), {
  sound: undefined,
});
t.roundStart();
// Team kill and suicide don't draw first blood.
assert.deepEqual(kill(k('Bob', 'Cid', { kt: 'T', vt: 'T' })), {});
assert.deepEqual(kill(k('', 'Cid', { kt: '', vt: 'T', weapon: 'world' })), {});
// Someone else's first blood: toast and sound for everyone (option on).
assert.deepEqual(kill(k('Bob', 'Ann', { kt: 'T', vt: 'CT' })), {
  firstBlood: 'Bob',
  sound: 'first-blood',
});
// Only once a round.
assert.deepEqual(kill(k('Bob', 'Dan', { kt: 'T', vt: 'CT' })), {
  sound: undefined,
});
// Option off: the toast stays, no sound.
t.roundStart();
assert.deepEqual(
  kill(k('Bob', 'Ann', { kt: 'T', vt: 'CT' }), { ...opts, others: false }),
  { firstBlood: 'Bob', sound: undefined }
);
// Own first blood plays even with others off; beats the headshot.
t.roundStart();
assert.deepEqual(
  kill(k('Me', 'Bob', { hs: true }), { ...opts, others: false }),
  { firstBlood: 'Me', sound: 'first-blood' }
);
// Headshot, and the option to turn them off.
assert.equal(kill(k('Me', 'Eve', { hs: true })).sound, 'headshot');
assert.equal(
  kill(k('Me', 'Fay', { hs: true }), { ...opts, headshots: false }).sound,
  undefined
);
// Headshot within a multi-kill: the multi-kill only.
assert.equal(
  kill(k('Me', 'Gus', { hs: true }), opts, 1000).sound,
  'double-kill'
);
assert.equal(
  kill(k('Me', 'Hal', { hs: true }), opts, 1000).sound,
  'triple-kill'
);
// Hal was the 5th kill in a row: the triple kill and the killing spree tie,
// and the multi-kill (listed first) plays.
assert.equal(stats.local()!.streak, 5);
assert.equal(kill(k('Me', 'Ivy'), opts, 1000).sound, 'quad-kill');
assert.equal(kill(k('Me', 'Jo'), opts, 1000).sound, 'rampage');
assert.equal(kill(k('Me', 'Kim'), opts, 1000).sound, 'rampage');
// Streak to 10 with gaps (no multi-kills): dominating at 10.
const seen: (string | undefined)[] = [];
for (let i = 9; i <= 20; i++) seen[i] = kill(k('Me', `V${i}`)).sound;
assert.equal(seen[9], undefined);
assert.equal(seen[10], 'dominating');
assert.equal(seen[15], 'unstoppable');
assert.equal(seen[20], 'godlike');
// Death resets the streak; 5 again plays killing spree again.
kill(k('Bob', 'Me', { kt: 'T', vt: 'CT' }));
for (let i = 1; i <= 4; i++) kill(k('Me', `W${i}`));
assert.equal(kill(k('Me', 'W5')).sound, 'killing-spree');
// Knife: humiliation for my kill (beats a headshot), knifed when I'm the
// victim, nothing for other players' knife kills.
assert.equal(
  kill(k('Me', 'X', { weapon: 'knife', hs: true })).sound,
  'humiliation'
);
assert.equal(
  kill(k('Bob', 'Me', { weapon: 'knife', kt: 'T', vt: 'CT' })).sound,
  'knifed'
);
assert.equal(
  kill(k('Bob', 'Ann', { weapon: 'knife', kt: 'T', vt: 'CT' })).sound,
  undefined
);
// Knifed by a teammate: not an enemy kill, nothing.
assert.deepEqual(
  kill(k('Ann', 'Me', { weapon: 'knife', kt: 'CT', vt: 'CT' })),
  {}
);
// Multi-kill window really comes from stats.
assert.equal(MULTI_KILL_WINDOW_MS, 4000);

// Deathmatch / Gun Game: first blood once per map, round starts ignored;
// a mode change starts over.
const dm = createAnnouncerTriggers();
const dmStats = createSessionStats();
dmStats.setLocalName('Me');
const dmKill = (e: ReturnType<typeof k>) =>
  dm.kill(e, dmStats.recordKill(e as any, (now += 10_000)), 'Me', opts);
dm.setGameMode(2);
assert.equal(dmKill(k('Bob', 'Ann', { kt: 'T', vt: 'CT' })).firstBlood, 'Bob');
dm.roundStart();
assert.equal(
  dmKill(k('Bob', 'Ann', { kt: 'T', vt: 'CT' })).firstBlood,
  undefined
);
dm.reset(); // new map, still Deathmatch: open at once
assert.equal(dmKill(k('Cid', 'Ann', { kt: 'T', vt: 'CT' })).firstBlood, 'Cid');
dm.setGameMode(1);
assert.equal(dmKill(k('Dan', 'Ann', { kt: 'T', vt: 'CT' })).firstBlood, 'Dan');
dm.setGameMode(1);
assert.equal(
  dmKill(k('Eve', 'Ann', { kt: 'T', vt: 'CT' })).firstBlood,
  undefined
);
assert.equal(dm.gameMode(), 1);

// Last man standing.
const p = (team: string, dead: boolean, local = false) =>
  ({ team, dead, local }) as any;
assert.equal(
  isLastMan([p('CT', false, true), p('CT', true), p('T', false)]),
  true
);
assert.equal(
  isLastMan([p('CT', false, true), p('CT', false), p('T', false)]),
  false
);
assert.equal(
  isLastMan([p('CT', false, true), p('CT', true), p('T', true)]),
  false,
  'no enemy alive'
);
assert.equal(
  isLastMan([p('CT', false, true), p('T', false)]),
  false,
  'alone on the team'
);
assert.equal(
  isLastMan([p('CT', true, true), p('CT', true), p('T', false)]),
  false,
  'dead'
);
assert.equal(
  isLastMan([p('SPEC', false, true), p('CT', true), p('T', false)]),
  false
);
assert.equal(
  isLastMan([
    p('CT', false, true),
    p('CT', true),
    p('SPEC', false),
    p('T', false),
  ]),
  true
);

const lm = createAnnouncerTriggers();
const alive = [p('CT', false, true), p('CT', false), p('T', false)];
const last = [p('CT', false, true), p('CT', true), p('T', false)];
// A snapshot of the last round's end (stale) doesn't fire until armed.
assert.equal(lm.scores(last), undefined);
assert.equal(lm.scores(alive), undefined);
assert.equal(lm.scores(last), 'last-man');
assert.equal(lm.scores(last), undefined, 'once a round');
assert.equal(lm.scores(alive), undefined);
assert.equal(lm.scores(last), undefined, 'still once a round');
lm.roundStart();
assert.equal(lm.scores(last), undefined, 'stale after round start');
assert.equal(lm.scores(alive), undefined);
assert.equal(lm.scores(last), 'last-man');
lm.setGameMode(2);
assert.equal(lm.scores(alive), undefined);
assert.equal(lm.scores(last), undefined, 'not in Deathmatch');

// Part A: mode events.
const gg = (o: Record<string, unknown>) =>
  parseModeState({ mode: 1, level: 1, levels: 24, weapon: 'Glock', ...o });
assert.equal(modeSound(undefined, gg({ level: 2 })), undefined, 'first state');
assert.equal(modeSound(gg({ level: 1 }), gg({ level: 2 })), 'level-up');
assert.equal(modeSound(gg({ level: 23 }), gg({ level: 24 })), 'final-level');
assert.equal(modeSound(gg({ level: 5 }), gg({ level: 4 })), undefined, 'down');
assert.equal(
  modeSound(gg({ level: 5 }), gg({ level: 5, kills: 1 })),
  undefined
);
assert.equal(
  modeSound(gg({ level: 24 }), gg({ level: 24, winner: 'Bob' })),
  'winner'
);
assert.equal(
  modeSound(gg({ level: 3 }), gg({ level: 3, winner: 'Bob' })),
  'winner',
  'someone else won'
);
assert.equal(
  modeSound(gg({ winner: 'Bob' }), gg({ winner: 'Bob' })),
  undefined
);
assert.equal(
  modeSound(gg({ level: 3, levels: 24 }), gg({ level: 4, levels: 10 })),
  undefined,
  'ladder changed'
);
assert.equal(modeSound(gg({}), parseModeState({ mode: 0 })), undefined);
assert.equal(
  modeSound(parseModeState({ mode: 2 }), parseModeState({ mode: 2 })),
  undefined
);

// Other players' multi-kills and streaks (otherStreaks): sound and toast
// text with the killer's name; nothing with the option off; never their
// headshots or knife kills.
{
  const st = createSessionStats();
  st.setLocalName('Me');
  const tr = createAnnouncerTriggers();
  tr.setGameMode(2); // first blood out of the way below
  let at = 0;
  const other = (e: ReturnType<typeof k>, options = opts, dt = 10_000) => {
    at += dt;
    return tr.kill(e, st.recordKill(e as any, at), 'Me', options);
  };
  const bob = (victim: string, o: any = {}) =>
    k('Bob', victim, { kt: 'T', vt: 'CT', ...o });
  assert.equal(other(bob('A1')).firstBlood, 'Bob');
  assert.deepEqual(other(bob('A2', { hs: true })), { sound: undefined });
  assert.deepEqual(other(bob('A3'), opts, 1000), {
    sound: 'double-kill',
    otherStreak: 'Bob: Double kill',
  });
  assert.deepEqual(other(bob('A4'), { ...opts, otherStreaks: false }, 1000), {
    sound: undefined,
  });
  // 5th kill in a row, also a quad kill: both in the toast; the sounds tie
  // and the multi-kill plays, as for my own kills.
  assert.deepEqual(other(bob('A5'), opts, 1000), {
    sound: 'quad-kill',
    otherStreak: 'Bob: Killing spree · Quad kill',
  });
  assert.deepEqual(other(bob('A6', { weapon: 'knife' })), {
    sound: undefined,
  });
  // A multi-kill chain is per killer: Cid's kill doesn't extend Bob's.
  assert.deepEqual(other(k('Cid', 'B1'), opts, 1000), { sound: undefined });
  assert.equal(other(bob('A7'), opts, 1000).otherStreak, 'Bob: Double kill');
  // Knifed by a player on a multi-kill: the victim hears the multi-kill.
  assert.deepEqual(other(bob('Me', { weapon: 'knife' }), opts, 1000), {
    sound: 'triple-kill',
    otherStreak: 'Bob: Triple kill',
  });
  // My own multi-kill isn't an "other" one.
  other(k('Me', 'C1'));
  assert.deepEqual(other(k('Me', 'C2'), opts, 1000), { sound: 'double-kill' });
}

console.log('smoke-announcer-c2: ok');
