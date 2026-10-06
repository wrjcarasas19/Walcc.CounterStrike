import assert from 'node:assert/strict';
import { createSessionStats, formatKd, formatHeadshots, multiKillLabel, MULTI_KILL_WINDOW_MS } from '/Users/wcarasas/Repos/Walcc.CounterStrike/src/client/src/stats.ts';

const k = (killer: string, victim: string, o: any = {}) => ({ killer, victim, weapon: o.weapon ?? 'ak47', headshot: !!o.hs, killerTeam: o.kt ?? 'CT', victimTeam: o.vt ?? 'T' });
const s = createSessionStats();
s.setLocalName('Me');
assert.deepEqual({ ...s.local()!, round: undefined }, { name: 'Me', kills: 0, deaths: 0, headshots: 0, teamKills: 0, suicides: 0, streak: 0, bestStreak: 0, round: undefined });
assert.equal(formatKd(s.local()!), '0.00'); assert.equal(formatHeadshots(s.local()!), '-');

// Round 1: Me double kill within window, then a third after window.
let r = s.recordKill(k('Me', 'Bob', { hs: true }), 1000);
assert.equal(r.kind, 'kill'); assert.equal(r.local!.multiKill, undefined);
r = s.recordKill(k('Me', 'Ann'), 1000 + MULTI_KILL_WINDOW_MS);
assert.deepEqual(r.local!.multiKill, { count: 2, label: 'Double kill' });
r = s.recordKill(k('Me', 'Cid'), 1000 + 2 * MULTI_KILL_WINDOW_MS);
assert.deepEqual(r.local!.multiKill, { count: 3, label: 'Triple kill' });
r = s.recordKill(k('Me', 'Dan'), 1000 + 3 * MULTI_KILL_WINDOW_MS + 1);
assert.equal(r.local!.multiKill, undefined, 'outside window restarts chain');
assert.equal(r.local!.streak, 4);
// Others' kills never produce local results
r = s.recordKill(k('Bob', 'Ann', { kt: 'T', vt: 'CT' }), 20000);
assert.equal(r.local, undefined);
// Me dies
s.recordKill(k('Bob', 'Me', { kt: 'T', vt: 'CT', hs: true }), 21000);
let me = s.local()!;
assert.equal(me.kills, 4); assert.equal(me.deaths, 1); assert.equal(me.headshots, 1); assert.equal(me.streak, 0); assert.equal(me.bestStreak, 4);
assert.equal(formatKd(me), '4.00'); assert.equal(formatHeadshots(me), '25%');
assert.equal(s.get('Bob')!.kills, 2); assert.equal(s.get('Bob')!.headshots, 1); assert.equal(s.get('Bob')!.deaths, 1);
assert.equal(s.get('Bob')!.round.kills, 2);

// Round 2
s.startRound();
assert.equal(s.get('Bob')!.round.kills, 0); assert.equal(s.get('Bob')!.kills, 2);
// suicide / world kill (killer '')
r = s.recordKill(k('', 'Me', { weapon: 'world', kt: '', vt: 'CT' }), 30000);
assert.equal(r.kind, 'suicide');
// grenade suicide where killer == victim (defensive)
r = s.recordKill(k('Ann', 'Ann', { weapon: 'grenade', kt: 'T', vt: 'T' }), 30001);
assert.equal(r.kind, 'suicide');
// teamkill
r = s.recordKill(k('Cid', 'Dan', { kt: 'T', vt: 'T' }), 30002);
assert.equal(r.kind, 'teamkill');
assert.equal(s.get('Cid')!.kills, 0); assert.equal(s.get('Cid')!.teamKills, 1); assert.equal(s.get('Dan')!.deaths, 2);
// local teamkill: no toast, no streak
s.recordKill(k('Me', 'Zed', { kt: 'CT', vt: 'CT' }), 30003);
r = s.recordKill(k('Me', 'Yan', { kt: 'CT', vt: 'CT' }), 30004);
assert.equal(r.local, undefined);
// non-player victim
r = s.recordKill(k('Me', 'func_breakable', { weapon: 'func_breakable', vt: '' }), 30005);
assert.equal(r.counted, false);
me = s.local()!;
assert.equal(me.deaths, 2); assert.equal(me.suicides, 1); assert.equal(me.teamKills, 2); assert.equal(me.round.deaths, 1); assert.equal(me.round.kills, 0);

// Renames via scores (userid)
s.updatePlayers([{ userid: 3, name: 'Me', local: true }, { userid: 5, name: 'Bob', local: false }]);
s.updatePlayers([{ userid: 3, name: 'Me2', local: true }, { userid: 5, name: 'Robert', local: false }]);
assert.equal(s.localName(), 'Me2'); assert.equal(s.local()!.kills, 4); assert.equal(s.get('Me'), undefined);
assert.equal(s.get('Robert')!.kills, 2);
// rename where the new name already has kills (kills arrived before the snapshot)
s.recordKill(k('Robby', 'Ann', { kt: 'T', vt: 'CT' }), 40000);
s.updatePlayers([{ userid: 5, name: 'Robby', local: false }]);
const rb = s.get('Robby')!;
assert.equal(rb.kills, 3); assert.equal(rb.deaths, 1); assert.equal(rb.bestStreak, 2); assert.equal(rb.streak, 1);
// no userid => ignored for renames, but local still followed
s.updatePlayers([{ name: 'X', local: false }, { userid: 0, name: 'Y', local: false }]);
// server-renamed local player "(1)Me2" picked up from snapshot
s.updatePlayers([{ userid: 3, name: '(1)Me2', local: true }]);
assert.equal(s.localName(), '(1)Me2'); assert.equal(s.local()!.kills, 4);

// copies are not live
const c = s.local()!; c.kills = 99; assert.equal(s.local()!.kills, 4);

// Reset (map change)
s.reset();
assert.equal(s.all().length, 0); assert.equal(s.local()!.kills, 0); assert.equal(s.localName(), '(1)Me2');
// chain cleared by reset
s.recordKill(k('(1)Me2', 'A'), 50000);
r = s.recordKill(k('(1)Me2', 'B'), 50001);
assert.equal(r.local!.multiKill!.count, 2);
s.reset();
r = s.recordKill(k('(1)Me2', 'C'), 50002);
assert.equal(r.local!.multiKill, undefined);
// rename tracking survives reset
s.updatePlayers([{ userid: 3, name: 'Fresh', local: true }]);
assert.equal(s.local()!.kills, 1);

// labels
assert.deepEqual([1,2,3,4,5,6,9].map(multiKillLabel), ['', 'Double kill', 'Triple kill', 'Quad kill', 'Penta kill', 'Rampage', 'Rampage']);
// No local name: no local results
const t = createSessionStats();
assert.equal(t.local(), undefined);
assert.equal(t.recordKill(k('Me', 'Bob'), 0).local, undefined);
console.log('ok');
