import assert from 'node:assert/strict';
import { createSessionStats } from '/Users/wcarasas/Repos/Walcc.CounterStrike/src/client/src/stats.ts';
import {
  createRoundStartDetector, pickRoundMvp, pickMapMvp, roundTitle, roundReasonText,
  roundScoreText, summaryRows, mapResultText, killsText,
} from '/Users/wcarasas/Repos/Walcc.CounterStrike/src/client/src/rounds.ts';

const k = (killer, victim, kt, vt, extra = {}) => ({ killer, victim, weapon: 'ak47', headshot: false, killerTeam: kt, victimTeam: vt, ...extra });

// titles / reasons
const end = (winner, reason, message, ct = 1, t = 2) => ({ winner, reason, message, ctScore: ct, tScore: t });
assert.equal(roundTitle(end('CT', 'defuse', '#Bomb_Defused')), 'Counter-Terrorists win');
assert.equal(roundTitle(end('T', 'bomb', '#Target_Bombed')), 'Terrorists win');
assert.equal(roundTitle(end('', 'draw', '#Round_Draw')), 'Round draw');
assert.equal(roundTitle(end('', 'commencing', '#Game_Commencing')), 'Game commencing');
assert.equal(roundReasonText(end('CT', 'time', '#Target_Saved')), 'Target saved');
assert.equal(roundReasonText(end('T', 'time', '#Hostages_Not_Rescued')), 'Hostages not rescued');
assert.equal(roundReasonText(end('T', 'time', '#Unknown')), 'Time ran out');
assert.equal(roundReasonText(end('CT', 'elimination', '#CTs_Win')), 'Enemy team eliminated');
assert.equal(roundReasonText(end('', 'draw', '#Round_Draw')), '');
assert.equal(roundReasonText({ ...end('', 'draw', ''), reason: 'future' } as any), '');
assert.equal(roundScoreText(end('CT', 'defuse', '', 3, 5)), 'CT 3 : 5 T');
assert.equal(roundScoreText({ ...end('CT', 'defuse', ''), ctScore: null }), '');

// round start detector
const d = createRoundStartDetector();
assert.equal(d.timer(115), false); // first
assert.equal(d.timer(114), false);
assert.equal(d.timer(115), false); // jitter +1
assert.equal(d.timer(3), false);
assert.equal(d.timer(0), false);
assert.equal(d.timer(5), true); // new round (freeze)
assert.equal(d.timer(0), false);
assert.equal(d.timer(115), true); // freeze end
d.reset();
assert.equal(d.timer(115), false);

// round MVP with round counters
const s = createSessionStats();
s.setLocalName('me');
s.recordKill(k('a', 'x', 'T', 'CT'), 0);
s.recordKill(k('b', 'y', 'CT', 'T', { headshot: true }), 0);
s.recordKill(k('a', 'z', 'T', 'CT'), 0);
assert.equal(pickRoundMvp(s.all())?.name, 'a');
s.startRound();
assert.equal(pickRoundMvp(s.all()), undefined);
s.recordKill(k('a', 'x', 'T', 'CT'), 0);
s.recordKill(k('b', 'y', 'CT', 'T', { headshot: true }), 0);
assert.equal(pickRoundMvp(s.all())?.name, 'b'); // tie -> headshots
s.recordKill(k('c', 'c', 'T', 'T'), 0); // suicide
s.recordKill(k('a', 'b', 'T', 'T'), 0); // teamkill not a kill
assert.equal(pickRoundMvp(s.all())?.name, 'b');
assert.equal(pickMapMvp(s.all())?.name, 'a'); // 3 kills total

// userid rename tracking in kills
const r = createSessionStats();
r.recordKill(k('old', 'v', 'T', 'CT', { killerUserid: 7, victimUserid: 9 }), 0);
r.recordKill(k('new', 'v', 'T', 'CT', { killerUserid: 7, victimUserid: 9 }), 0);
assert.equal(r.get('old'), undefined);
assert.equal(r.get('new')?.kills, 2);
assert.equal(r.get('v')?.deaths, 2);
// suicide: killer "" userid 0 ignored
r.recordKill(k('', 'new', '', 'T', { killerUserid: 0, victimUserid: 7 }), 0);
assert.equal(r.get('new')?.suicides, 1);
// scores later agree
r.updatePlayers([{ userid: 7, name: 'new', local: false }]);
assert.equal(r.get('new')?.kills, 2);
// old-style kill without userids still works
r.recordKill(k('new', 'w', 'T', 'CT'), 0);
assert.equal(r.get('new')?.kills, 3);

// summary rows
const rows = summaryRows(
  [
    { name: 'me', team: 'CT', frags: 3, deaths: 1, bot: false, local: true },
    { name: 'a', team: 'T', frags: 5, deaths: 2, bot: true, local: false },
    { name: 'b', team: 'CT', frags: 4, deaths: 0, bot: false, local: false },
    { name: 'spec', team: 'SPEC', frags: 0, deaths: 0, bot: false, local: false },
  ],
  s.all()
);
assert.deepEqual(rows.map((x) => x.name), ['b', 'me', 'a', 'spec', 'c', 'x', 'y', 'z'].filter((n) => rows.some((r) => r.name === n)));
assert.equal(rows[0].name, 'b');
assert.equal(rows[1].name, 'me');
assert.equal(rows[2].name, 'a');
assert.equal(rows[2].kills, 3);
const left = rows.filter((x) => x.frags === null).map((x) => x.name);
assert.deepEqual(left.sort(), ['c', 'x', 'y', 'z']);
assert.equal(mapResultText(8, 5), 'Counter-Terrorists win the map 8 : 5');
assert.equal(mapResultText(2, 7), 'Terrorists win the map 7 : 2');
assert.equal(mapResultText(4, 4), 'Draw 4 : 4');
assert.equal(killsText(1), '1 kill');
console.log('round62 smoke OK', rows.map((x) => `${x.name}:${x.team}:${x.frags}`).join(' '));
