import { parseLobbyStatus, summaryText, timeLeftText, sortPlayers } from '/Users/wcarasas/Repos/Walcc.CounterStrike/src/client/src/lobby.ts';
const ok = (cond: boolean, m: string) => { if (!cond) { console.log('FAIL', m); process.exitCode = 1; } };
const good = { map: 'de_dust2', playerCount: 5, maxPlayers: 16, bots: 3, players: [{ name: 'b', frags: 1 }, { name: '<img>', frags: 7, bot: true }, { name: 'a', frags: 1 }], timeLimit: 30, timeLeft: 727, nextMap: 'de_aztec' };
const s = parseLobbyStatus(good)!;
ok(!!s && summaryText(s) === 'de_dust2 · 5/16 players', 'summary ' + (s && summaryText(s)));
ok(timeLeftText(s) === '12:07 left', 'time ' + timeLeftText(s));
ok(sortPlayers(s.players).map((p) => p.name).join() === '<img>,a,b', 'sort');
ok(s.players[1].bot && !s.players[0].bot, 'bot flag');
ok(s.nextMap === 'de_aztec', 'next');
const nulls = parseLobbyStatus({ ...good, timeLeft: null, timeLimit: null, nextMap: undefined })!;
ok(timeLeftText(nulls) === '' && nulls.timeLimit === null && nulls.nextMap === '', 'nulls');
ok(timeLeftText({ ...s, timeLeft: 5 }) === '0:05 left', 'short time');
ok(summaryText({ ...s, maxPlayers: 1, playerCount: 0 }) === 'de_dust2 · 0/1 player', 'singular');
for (const bad of [null, 'x', {}, { ...good, map: '' }, { ...good, map: 3 }, { ...good, playerCount: -1 }, { ...good, maxPlayers: 1.5 }, { ...good, players: 'x' }, { ...good, players: [{ name: 1, frags: 0 }] }, { ...good, players: [{ name: 'a', frags: '1' }] }, { ...good, players: [null] }])
  ok(parseLobbyStatus(bad) === undefined, 'bad ' + JSON.stringify(bad));
ok(parseLobbyStatus({ ...good, players: [{ name: 'x'.repeat(100), frags: -3 }] })!.players[0].name.length === 64, 'name cap');
ok(parseLobbyStatus({ ...good, timeLeft: -5 })!.timeLeft === null, 'negative time');
console.log('done');
