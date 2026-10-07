// C.2 announcer in headless Chromium against the image:
// - no sound file is fetched on the login page, all 16 are after joining;
// - sounds are dropped while the AudioContext is suspended and play after
//   the first key press (headless Chromium never enforces the autoplay
//   policy, even with --autoplay-policy=user-gesture-required, so the test
//   page's AudioContext is made to start suspended and to refuse resume()
//   until a key has been pressed);
// - real kills by bots: "<killer> drew first blood" toast + first-blood
//   sound after a round restart; live scores arrive (last man standing);
// - synthetic bridge events through the page's own hudEvent (the local
//   player can't aim here): headshot, multi-kills, streaks, humiliation,
//   knifed, last man standing, priorities.
// The page logs "announcer: ..." with console.debug for every play / drop.
// usage: ./run-server.sh de_dust2 6 && ./pw.sh check-announcer.mjs
// Leaves the server without bots.
import { chromium } from 'playwright';
import {
  BASE,
  adminAction,
  joinGame,
  launch,
  newPage,
  shot,
  waitForPlayer,
} from './lib.mjs';

const NAME = 'AnnCheck';
let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

// Bots in (an earlier run of this script kicks them at the end).
await adminAction({ action: 'bot_quota', players: 6 });

const browser = await launch();
const page = await newPage(browser, { tag: 'ann' });
await page.addInitScript(() => {
  window.__keyPressed = false;
  window.addEventListener('keydown', () => (window.__keyPressed = true), {
    capture: true,
  });
  const Real = window.AudioContext;
  window.AudioContext = class extends Real {
    constructor(...args) {
      super(...args);
      void super.suspend();
    }
    resume() {
      return window.__keyPressed ? super.resume() : Promise.resolve();
    }
  };
});
const soundRequests = [];
const soundResponses = [];
page.on('request', (r) => {
  if (new URL(r.url()).pathname.startsWith('/sounds/')) soundRequests.push(r.url());
});
page.on('response', (r) => {
  if (new URL(r.url()).pathname.startsWith('/sounds/')) {
    soundResponses.push(`${r.status()} ${r.headers()['content-type']}`);
  }
});
const logs = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (text.startsWith('announcer:')) {
    logs.push(text);
    console.log(`  [${msg.type()}] ${text}`);
  }
});

await page.goto(BASE);
await page.waitForTimeout(5000);
check(soundRequests.length === 0, `login page fetched ${soundRequests.length} sound files`);

await joinGame(page, { name: NAME });
await waitForPlayer(NAME);
const waitLog = async (re, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = logs.find((l) => re.test(l));
    if (hit) return hit;
    await page.waitForTimeout(250);
  }
  return undefined;
};
const loaded = await waitLog(/loaded \d+\/16/, 30_000);
check(loaded === 'announcer: loaded 16/16 sounds (.webm)', `after joining: ${loaded}`);
check(
  soundRequests.length === 16 && soundRequests.every((u) => u.endsWith('.webm')),
  `${soundRequests.length} sound requests, all .webm`
);
console.log(`  responses: ${[...new Set(soundResponses)].join(', ')}`);

// Suspended until a key: a sound is dropped, then a key resumes the audio.
const sendMode = (payload) =>
  page.evaluate((p) => window.__engine.em.Module.hudEvent('mode', p), payload);
const ggState = (level) => ({ mode: 1, level, levels: 24, weapon: 'Glock' });
logs.length = 0;
await sendMode(ggState(1));
await sendMode(ggState(2));
await page.waitForTimeout(300);
check(
  logs.includes('announcer: level-up dropped (audio suspended)'),
  `before a key: ${logs.join(' | ')}`
);
await page.keyboard.press('Shift');
await page.waitForTimeout(500);
await sendMode(ggState(3));
await page.waitForTimeout(300);
check(
  logs.includes('announcer: audio running') &&
    logs.includes('announcer: play level-up'),
  `after a key: ${logs.join(' | ')}`
);
await sendMode({ mode: 0 });

// Count bridge events the page gets.
await page.evaluate(() => {
  const module = window.__engine.em.Module;
  const original = module.hudEvent;
  window.__events = {};
  window.__toasts = [];
  module.hudEvent = (type, payload) => {
    window.__events[type] = (window.__events[type] ?? 0) + 1;
    original(type, payload);
  };
  const toast = document.getElementById('hud-toast-text');
  new MutationObserver(() => window.__toasts.push(toast.textContent)).observe(
    toast,
    { childList: true, characterData: true, subtree: true }
  );
});

// The local player stays out of the teams (no real death can break the
// synthetic streaks below); the bots play.
// Real kills: restart the round, wait for the bots' first kill.
logs.length = 0;
console.log('restart:', (await adminAction({ action: 'restart' })).status);
const fb = await waitLog(/first-blood/, 150_000);
check(!!fb, `real first blood after a restart: ${fb}`);
const toasts = await page.evaluate(() => window.__toasts);
const fbToast = toasts.find((t) => / drew first blood$/.test(t));
check(!!fbToast, `toast "${fbToast}"`);
const t0 = Date.now();
await shot(page, 'announcer-first-blood');
console.log(
  `  screenshot took ${Date.now() - t0} ms; toast:`,
  await page.evaluate(() => {
    const el = document.getElementById('hud-toast-text');
    return `${el.className} opacity ${getComputedStyle(el).opacity}`;
  })
);
const fbCount = logs.filter((l) => /play first-blood/.test(l)).length;
await page.waitForTimeout(10_000);
check(
  logs.filter((l) => /play first-blood/.test(l)).length === fbCount,
  'no second first blood in the same round'
);
const events = await page.evaluate(() => window.__events);
console.log('  events:', JSON.stringify(events));
check((events.scores ?? 0) > 10, `live scores without the scoreboard: ${events.scores}`);

// Bots out, so no new round starts during the synthetic part.
console.log('bots out:', (await adminAction({ action: 'bot_kick_all' })).status);
await adminAction({ action: 'bot_quota', players: 0 });
await page.waitForTimeout(5000);

// Synthetic events through the page's hudEvent (the real handler).
const send = (type, payload) =>
  page.evaluate(([t, p]) => window.__engine.em.Module.hudEvent(t, p), [type, payload]);
const k = (killer, victim, o = {}) => ({
  killer,
  victim,
  weapon: o.weapon ?? 'ak47',
  headshot: !!o.hs,
  killerTeam: o.kt ?? 'T',
  victimTeam: o.vt ?? 'CT',
});
async function expectSound(label, fn, re, wait = 1500) {
  logs.length = 0;
  await fn();
  await page.waitForTimeout(wait);
  const hit = logs.find((l) => re.test(l));
  check(!!hit, `${label}: ${logs.join(' | ') || '(nothing)'}`);
}
const me = NAME;
await expectSound('headshot', () => send('kill', k(me, 'Fake1', { hs: true })), /play headshot/);
await expectSound(
  'double kill + headshot: no headshot sound',
  () => send('kill', k(me, 'Fake2', { hs: true })),
  /^announcer: play double-kill$/
);
check(!logs.some((l) => /headshot/.test(l)), 'no headshot log for the double kill');
await expectSound('triple kill', () => send('kill', k(me, 'Fake3')), /play triple-kill/);
await expectSound('quad kill', () => send('kill', k(me, 'Fake4')), /play quad-kill/);
await expectSound('rampage (streak 5 ties, multi wins)', () => send('kill', k(me, 'Fake5')), /play rampage/);
// Priority drop: a quick headshot after a fresh multi-kill sound... the
// chain ended (4 s), so make a new double kill and a lower sound right after.
await page.waitForTimeout(4500);
for (let i = 6; i <= 9; i++) {
  await send('kill', k(me, `Gap${i}`));
  await page.waitForTimeout(4500);
}
await expectSound('dominating at streak 10', () => send('kill', k(me, 'Fake10')), /play dominating/);
await page.waitForTimeout(4500);
await expectSound('humiliation', () => send('kill', k(me, 'Fake11', { weapon: 'knife' })), /play humiliation/);
await expectSound(
  'lower priority dropped while a higher one plays',
  async () => {
    await send('kill', k(me, 'Fake12')); // double kill
    await send('kill', k('SomeBot', me, { weapon: 'knife', kt: 'CT', vt: 'T' }));
  },
  /knifed dropped \(double-kill playing\)/
);
await page.waitForTimeout(4500);
await expectSound(
  'knifed',
  () => send('kill', k('SomeBot', me, { weapon: 'knife', kt: 'CT', vt: 'T' })),
  /play knifed/
);

// Last man standing from scores (team T, as joined above).
const player = (id, name, team, dead, local = false) => ({
  id, userid: 100 + id, name, team, frags: 0, deaths: 0, ping: 5,
  dead, bomb: false, vip: false, bot: !local, local,
});
const scores = (mateDead) => ({
  map: 'de_dust2', server: 'x',
  teams: { CT: { score: 0, players: 1, avgPing: 5 }, T: { score: 0, players: 2, avgPing: 5 } },
  players: [player(1, me, 'T', false, true), player(2, 'Mate', 'T', mateDead), player(3, 'Foe', 'CT', false)],
});
// Real snapshots keep coming at 2 Hz and can re-arm or fire on their own;
// send ours back to back.
await expectSound(
  'last man standing',
  async () => {
    await send('scores', scores(false));
    await send('scores', scores(true));
  },
  /play last-man/
);

// Part A sounds through the mode event (inactive with 0.0.9 but wired).
await page.waitForTimeout(2500); // last-man is 2 s long
const gg = (o) => ({ mode: 1, level: 1, levels: 24, kills: 0, killsNeeded: 1, leaderLevel: 1, weapon: 'Glock', next: 'USP', leader: '', winner: '', protection: 0, ...o });
await send('mode', gg({ level: 1 }));
await expectSound('level up', () => send('mode', gg({ level: 2 })), /play level-up/);
await expectSound('final level', () => send('mode', gg({ level: 24 })), /play final-level/);
await expectSound('winner', () => send('mode', gg({ level: 24, winner: 'Bob' })), /play winner/);
await send('mode', { mode: 0 });

console.log(failures ? `${failures} FAILED` : 'all passed');
await browser.close();
process.exit(failures ? 1 : 0);
