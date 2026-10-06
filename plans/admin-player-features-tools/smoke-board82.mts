import { parseLeaderboard, kdText, headshotText, noteText } from '/Users/wcarasas/Repos/Walcc.CounterStrike/src/client/src/leaderboard.ts';
const ok = (cond: boolean, m: string) => { if (!cond) { console.log('FAIL', m); process.exitCode = 1; } };
const row = { rank: 1, name: '<img src=x>', kills: 10, deaths: 3, kd: 3.33, headshots: 4, headshotPercent: 40, rounds: 7 };
const good = { players: [row, { ...row, rank: 2, name: 'Cy', kills: 0, kd: 0, headshots: 0, headshotPercent: null, rounds: undefined }], bots: false };
const b = parseLeaderboard(good)!;
ok(!!b && b.players.length === 2 && b.players[0].name === '<img src=x>' && !b.bots, 'parse');
ok(b.players[1].headshotPercent === null && b.players[1].rounds === 0, 'nulls');
ok(kdText(3.33) === '3.33' && kdText(2) === '2.00' && kdText(0) === '0.00', 'kd');
ok(headshotText(40) === '40%' && headshotText(null) === '-' && headshotText(0) === '0%', 'hs');
ok(noteText(b) === 'Bots are not listed. Names are not verified: anyone can play under any name.', 'note ' + noteText(b));
ok(noteText({ players: [], bots: true }) === 'No kills recorded yet. Names are not verified: anyone can play under any name.', 'empty note');
ok(parseLeaderboard({ players: [], bots: true })!.bots, 'bots flag');
ok(parseLeaderboard({ players: [{ ...row, name: 'x'.repeat(100) }] })!.players[0].name.length === 64, 'name cap');
ok(parseLeaderboard({ players: Array.from({ length: 30 }, (_, i) => ({ ...row, rank: i + 1 })) })!.players.length === 20, 'row cap');
for (const bad of [null, 'x', {}, { players: 'x' }, { players: [null] }, { players: [{ ...row, name: 1 }] }, { players: [{ ...row, kills: -1 }] }, { players: [{ ...row, kd: 'x' }] }, { players: [{ ...row, kd: Infinity }] }, { players: [{ ...row, headshotPercent: '40' }] }, { players: [{ ...row, rank: 1.5 }] }])
  ok(parseLeaderboard(bad) === undefined, 'bad ' + JSON.stringify(bad));
console.log('done');
