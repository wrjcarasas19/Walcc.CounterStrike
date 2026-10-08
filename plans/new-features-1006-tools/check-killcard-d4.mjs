// D.4 "Killed by" card in the game (headless Chromium against the image),
// with real deaths of the local player:
// - Deathmatch, bots kill the player: "Killed by <bot>" in the bot's team
//   colour, the weapon, "This map: you 0 – n <bot>" counting up over the
//   deaths, "<bot> is on a n kill streak" from 3 (checked against the kill
//   feed), still up after the player respawns;
// - `kill` in the console: "You killed yourself", no duel lines;
// - the Killer card setting (F3) off: no card on a death; on again: back;
// - no all-time line on a fresh server; after a reconnect (all-time cache
//   cleared) the second death by a bot that killed the player before shows
//   "All time: 0 – n" equal to GET /duel and the kill feed (needs
//   LEADERBOARD_BOTS=1 and a fresh server);
// - classic rounds: the card stays up while spectating after death until
//   15 s, and also through a round start (admin restart).
// The card must stay below the crosshair and inside the viewport.
// usage: LEADERBOARD_BOTS=1 ./run-server.sh de_dust2 8 && ./pw.sh check-killcard-d4.mjs
//        VIEWPORT=phone (844×390 touch) for the phone size; WAIT_SCALE=2
//        doubles the waits for deaths on a slow host.
// Leaves the server in classic mode with its bots.
import {
  BASE,
  adminAction,
  engineCommand,
  joinGame,
  launch,
  newPage,
  shot,
  waitForPlayer,
} from './lib.mjs';

const PHONE = process.env.VIEWPORT === 'phone';
const SIZE = PHONE
  ? { width: 844, height: 390, touch: true }
  : { width: 1280, height: 800 };
const TAG = PHONE ? 'phone' : 'desktop';
const NAME = PHONE ? 'KcPhone' : 'KcCheck';
const DEATHS = Number(process.env.DEATHS || (PHONE ? 3 : 6));
// Longer waits for deaths on a slow host (the bots find the player less
// often when the VM's CPU is contended), e.g. WAIT_SCALE=2.
const WAIT_SCALE = Number(process.env.WAIT_SCALE || 1);

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setMode(mode) {
  await adminAction({ action: 'cvar', name: 'wc_gamemode', value: mode });
  await adminAction({ action: 'cvar', name: 'mp_freezetime', value: 0 });
  console.log('restart', (await adminAction({ action: 'restart' })).status);
}

await adminAction({ action: 'bot_quota', players: 9 });
await adminAction({ action: 'bot_difficulty', level: 4 });
// No map change in the middle (it would rename the bots).
await adminAction({ action: 'cvar', name: 'mp_timelimit', value: 0 });
await setMode(2);

const browser = await launch();
const page = await newPage(browser, { tag: TAG, ...SIZE });
await joinGame(page, { name: NAME });
await waitForPlayer(NAME);

// Records every bridge event and every change of the card, with times.
async function record() {
  await page.evaluate(() => {
    const module = window.__engine.em.Module;
    if (!window.__kcHooked) {
      window.__kcHooked = true;
      window.__ev = [];
      window.__cards = [];
      const original = module.hudEvent;
      module.hudEvent = (type, payload) => {
        if (type === 'kill' || type === 'alive' || type === 'reset' || type === 'round') {
          window.__ev.push({ t: performance.now(), type, payload });
        }
        original(type, payload);
      };
      const card = document.getElementById('hud-killcard');
      const snap = () => {
        const r = card.getBoundingClientRect();
        const killer = card.querySelector('.hud-kc-killer');
        window.__cards.push({
          t: performance.now(),
          hidden: card.hidden,
          kind: card.className,
          title: card.querySelector('.hud-kc-title')?.textContent ?? '',
          killer: killer?.textContent ?? '',
          killerClass: killer?.className ?? '',
          weapon: card.querySelector('.hud-kc-weapon-name')?.textContent ?? '',
          duel: [...card.querySelectorAll('.hud-kc-duel')].map((d) => d.textContent),
          streak: card.querySelector('.hud-kc-streak')?.textContent ?? '',
          box: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
          view: { w: innerWidth, h: innerHeight },
          shown: !card.hidden && r.height > 0 && getComputedStyle(card).display !== 'none',
        });
      };
      new MutationObserver(snap).observe(card, {
        attributes: true,
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  });
}
await record();

async function joinTeam() {
  await engineCommand(page, 'jointeam 2');
  await page.waitForTimeout(500);
  await engineCommand(page, 'joinclass 1');
}
await joinTeam();

const state = () =>
  page.evaluate(() => ({ ev: window.__ev, cards: window.__cards, now: performance.now() }));
const myDeaths = (ev) =>
  ev.filter((e) => e.type === 'kill' && e.payload.victim === NAME);

const byBots = (ev) =>
  myDeaths(ev).filter((d) => d.payload.killer && d.payload.killer !== NAME);

/**
 * Waits for `n` more deaths of the local player by bots (or the timeout).
 * With `nudge` (Deathmatch), the player kills themself after 45 s without
 * one, to respawn somewhere the bots go.
 */
async function waitDeaths(n, ms, nudge = false) {
  const start = byBots((await state()).ev).length;
  const deadline = Date.now() + ms;
  let last = Date.now();
  let seen = start;
  while (Date.now() < deadline) {
    const now = byBots((await state()).ev).length;
    if (now - start >= n) return now - start;
    if (now !== seen) {
      seen = now;
      last = Date.now();
    } else if (nudge && Date.now() - last > 45_000) {
      await engineCommand(page, 'kill');
      last = Date.now();
    }
    await sleep(1000);
  }
  return byBots((await state()).ev).length - start;
}

/** The card's state when it was last drawn within `ms` after time t. */
function cardAfter(cards, t, ms = 1000) {
  const within = cards.filter((c) => c.t >= t && c.t <= t + ms && !c.hidden);
  return within.at(-1);
}

/** Checks the card for each enemy death in `deaths` against the kill feed. */
function checkEnemyCards(ev, cards, deaths, label) {
  // Kill feed tallies since the last reset before each death.
  let shotOnce = false;
  let streakSeen = 0;
  for (const d of deaths) {
    const before = ev.filter((e) => e.t <= d.t);
    const lastReset = before.findLastIndex((e) => e.type === 'reset');
    const feed = before.slice(lastReset + 1).filter((e) => e.type === 'kill').map((e) => e.payload);
    const k = d.payload;
    const enemy = (x) => x.killer && x.killer !== x.victim && x.killerTeam !== x.victimTeam;
    const byThem = feed.filter((x) => enemy(x) && x.killer === k.killer && x.victim === NAME).length;
    const byMe = feed.filter((x) => enemy(x) && x.killer === NAME && x.victim === k.killer).length;
    let streak = 0;
    for (const x of feed) {
      if (x.victim === k.killer) streak = 0;
      else if (enemy(x) && x.killer === k.killer) streak++;
    }
    const c = cardAfter(cards, d.t);
    if (!c) {
      check(false, `${label}: no card after death by ${k.killer} (${k.weapon})`);
      continue;
    }
    const teamClass = k.killerTeam === 'CT' ? 'ct' : k.killerTeam === 'T' ? 't' : '';
    const expectMap = `This map: you ${byMe} – ${byThem} ${k.killer}`;
    const expectStreak = streak >= 3 ? `${k.killer} is on a ${streak} kill streak` : '';
    if (expectStreak) streakSeen++;
    // The page counts from its connect, this check from its hook a few
    // seconds later, so the card may know a few more kills than the tally.
    const shownStreak = Number(/on a (\d+) kill streak$/.exec(c.streak)?.[1] ?? 0);
    const streakOk =
      c.streak === expectStreak ||
      (shownStreak > streak && shownStreak >= 3 &&
        c.streak === `${k.killer} is on a ${shownStreak} kill streak`);
    if (streakOk && c.streak !== expectStreak) {
      console.log(`  note: card streak ${shownStreak}, the check saw ${streak} (kills before its hook)`);
    }
    check(
      c.title === 'Killed by' &&
        c.killer === k.killer &&
        c.killerClass.split(' ').includes(teamClass) &&
        c.weapon !== '' &&
        c.duel[0] === expectMap &&
        streakOk,
      `${label}: "${c.title} ${c.killer}" [${c.killerClass}] ${c.weapon} | ${c.duel.join(' | ')} | ${c.streak || '(no streak)'}` +
        `  (expected ${k.killerTeam} ${expectMap}${expectStreak ? ' / ' + expectStreak : ''})`
    );
    const { box, view } = c;
    check(
      box.top > view.h / 2 && box.bottom <= view.h && box.left >= 0 && box.right <= view.w,
      `${label}: card ${Math.round(box.top)}–${Math.round(box.bottom)} px in a ${view.w}×${view.h} view (below the crosshair at ${view.h / 2})`
    );
    if (!shotOnce) shotOnce = true;
  }
  return streakSeen;
}

/** Waits until the local player is alive and playing; restarts the round if not. */
async function ensureAlive() {
  for (let attempt = 0; attempt < 4; attempt++) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const last = (await state()).ev.filter((e) => e.type === 'alive').at(-1)?.payload;
      if (last?.alive && !last.spectating) return true;
      await sleep(500);
    }
    console.log('not alive yet: restart', (await adminAction({ action: 'restart' })).status);
    await page.waitForTimeout(3000);
  }
  return false;
}
// 1. Deathmatch: bots kill the player DEATHS times.
console.log(`waiting for ${DEATHS} deaths (Deathmatch)...`);
let got = await waitDeaths(1, 120_000 * WAIT_SCALE, true);
// A screenshot of the first card while it is up.
await page.waitForTimeout(300);
await shot(page, `d4-${TAG}-card`);
got += await waitDeaths(DEATHS - 1, 480_000 * WAIT_SCALE, true);
let s = await state();
let deaths = myDeaths(s.ev).filter((d) => d.payload.killer && d.payload.killer !== NAME);
check(got >= DEATHS, `${got} deaths by bots`);
const streaks = checkEnemyCards(s.ev, s.cards, deaths, 'DM');
console.log(`  streak lines expected: ${streaks}`);
const repeat = new Set(
  deaths.map((d) => d.payload.killer).filter((k, i, a) => a.indexOf(k) !== i)
);
console.log(`  killers seen twice or more: ${[...repeat].join(', ') || '(none)'}`);

// Kept on respawn: the card is still up right after "alive and playing".
for (const d of deaths) {
  const respawn = s.ev.find(
    (e) => e.type === 'alive' && e.t > d.t && e.payload.alive && !e.payload.spectating
  );
  if (!respawn || respawn.t - d.t > 5500) continue;
  const hidden = s.cards.find(
    (c) => c.t >= respawn.t && c.t < respawn.t + 1000 && c.hidden
  );
  check(
    !hidden,
    `DM: card still up after respawn (${((respawn.t - d.t) / 1000).toFixed(1)} s after death)`
  );
  break;
}

// 2. `kill` in the console.
check(await ensureAlive(), 'alive before the self kill');
await page.waitForTimeout(1500);
let t0 = (await state()).now;
await engineCommand(page, 'kill');
await page.waitForTimeout(800);
s = await state();
let self = myDeaths(s.ev).find((e) => e.t >= t0);
let c = self && cardAfter(s.cards, self.t);
check(
  !!c && c.title === 'You killed yourself' && c.duel.length === 0 && !c.killer,
  `kill: ${JSON.stringify(self?.payload)} → "${c?.title}" duel lines ${c?.duel.length}`
);
await shot(page, `d4-${TAG}-self`);

// 3. Setting off, then on.
async function setKillerCard(on) {
  await page.keyboard.press('F3');
  await page.waitForTimeout(500);
  const found = await page.evaluate((want) => {
    const input = document.querySelector('#setting-killerCard');
    if (!input) return false;
    if (input.checked !== want) input.click();
    return input.checked === want;
  }, on);
  await page.keyboard.press('F3');
  await page.waitForTimeout(500);
  return found;
}
check(await setKillerCard(false), 'F3: Killer card turned off');
await ensureAlive();
await page.waitForTimeout(1500);
t0 = (await state()).now;
const offFrom = t0;
await engineCommand(page, 'kill');
await page.waitForTimeout(1500);
s = await state();
const offDeaths = myDeaths(s.ev).filter((e) => e.t >= t0);
check(
  offDeaths.length > 0 && !s.cards.some((x) => x.t >= t0 && !x.hidden),
  `setting off: ${offDeaths.length} deaths, no card shown`
);
check(await setKillerCard(true), 'F3: Killer card turned on');
const offUntil = (await state()).now;
await ensureAlive();
await page.waitForTimeout(1500);
t0 = (await state()).now;
await engineCommand(page, 'kill');
await page.waitForTimeout(800);
s = await state();
self = myDeaths(s.ev).find((e) => e.t >= t0);
c = self && cardAfter(s.cards, self.t);
check(!!c && c.title === 'You killed yourself', `setting on again: "${c?.title}"`);

// 4. All time. /duel is asked 2.5 s after the first death by a killer (when
// the server has the kill), so on a fresh server no card may have an
// all-time line (the server never has anything from before this map). A
// reconnect clears the cache like a new map (a map change would rename the
// bots); then the second death by an earlier killer shows "All time: 0 – n"
// with n = GET /duel (needs LEADERBOARD_BOTS=1 and a fresh server).
s = await state();
for (const d of myDeaths(s.ev)) {
  const k = d.payload.killer;
  if (!k || k === NAME || (d.t >= offFrom && d.t <= offUntil)) continue;
  const card = s.cards.filter((c) => c.t >= d.t && c.t <= d.t + 4000 && !c.hidden && c.killer === k).at(-1);
  check(
    !!card && !card.duel.some((x) => x.startsWith('All time')),
    `fresh server, by ${k}: no all-time line (${card?.duel.join(' | ')})`
  );
}
const before = new Map();
for (const d of myDeaths(s.ev)) {
  if (d.payload.killer && d.payload.killer !== NAME) {
    before.set(d.payload.killer, (before.get(d.payload.killer) ?? 0) + 1);
  }
}
if (!PHONE) {
  await page.waitForTimeout(4000); // the log follower reads every 2 s
  await page.evaluate(() => window.__engine.rejoin());
  const resetDeadline = Date.now() + 120_000;
  while (Date.now() < resetDeadline) {
    const r = (await state()).ev.filter((e) => e.type === 'reset' && e.t > t0);
    if (r.length) break;
    await sleep(1000);
  }
  await waitForPlayer(NAME);
  await page.waitForTimeout(5000);
  await joinTeam();
  const t1 = (await state()).now;
  let allTimeCard;
  const deadline = Date.now() + 480_000 * WAIT_SCALE;
  while (Date.now() < deadline && !allTimeCard) {
    await waitDeaths(1, 60_000, true);
    s = await state();
    const after = myDeaths(s.ev).filter((e) => e.t >= t1);
    for (const [i, d] of after.entries()) {
      const k = d.payload.killer;
      if (!before.has(k)) continue;
      const first = after.find((e) => e.payload.killer === k);
      if (first === d || d.t - first.t < 3000) continue;
      const card = cardAfter(s.cards, d.t);
      if (card) {
        allTimeCard = { d, card, n: before.get(k) + after.slice(0, i + 1).filter((e) => e.payload.killer === k).length };
        break;
      }
    }
  }
  if (!allTimeCard) {
    check(false, `no second death after the reconnect by an earlier killer (${[...before.keys()].join(', ')})`);
  } else {
    const killer = allTimeCard.d.payload.killer;
    // Past the follower's 2 s and the server's 5 s cache of the pair.
    await page.waitForTimeout(8000);
    const duel = await (
      await fetch(`${BASE}/duel?a=${encodeURIComponent(NAME)}&b=${encodeURIComponent(killer)}`)
    ).json();
    const line = allTimeCard.card.duel.find((x) => x.startsWith('All time'));
    // The server now: every death by them so far (more may have come).
    const total =
      before.get(killer) +
      myDeaths((await state()).ev).filter((e) => e.t >= t1 && e.payload.killer === killer).length;
    check(
      line === `All time: 0 – ${allTimeCard.n}` && duel.bKills === total,
      `all time after the reconnect, killed by ${killer}: "${line}" (${allTimeCard.n} deaths by them in the feed then; server now ${JSON.stringify(duel)}, feed now ${total}) | ${allTimeCard.card.duel.join(' | ')}`
    );
    await shot(page, `d4-${TAG}-alltime`);
  }
  s = await state();
  checkEnemyCards(
    s.ev,
    s.cards,
    myDeaths(s.ev).filter((d) => d.t >= t1 && d.payload.killer && d.payload.killer !== NAME),
    'after the reconnect'
  );
}

// 5. Classic rounds: spectating after death and a round start keep the card.
await setMode(0);
await page.waitForTimeout(6000);
await joinTeam();
check(await ensureAlive(), 'classic: alive before the self kill');
await page.waitForTimeout(1000);
t0 = (await state()).now;
await engineCommand(page, 'kill');
await page.waitForTimeout(4500);
s = await state();
self = myDeaths(s.ev).find((e) => e.t >= t0);
const spect = s.ev.filter((e) => e.type === 'alive' && e.t > t0).map((e) => e.payload);
const last = s.cards.at(-1);
check(
  !!self && !!last && !last.hidden && last.title === 'You killed yourself',
  `classic: card still up ${((s.now - (self?.t ?? s.now)) / 1000).toFixed(1)} s after death while dead / spectating (alive events: ${JSON.stringify(spect.at(-1))})`
);
await shot(page, `d4-${TAG}-spectating`);
await page.waitForTimeout(11000);
s = await state();
check(s.cards.at(-1)?.hidden === true, 'classic: card gone after 15 s');

// Round start: die, then restart the round.
check(await ensureAlive(), 'classic: alive again before the round start check');
await page.waitForTimeout(1000);
t0 = (await state()).now;
await engineCommand(page, 'kill');
await page.waitForTimeout(1000);
await adminAction({ action: 'restart' });
const restartAt = (await state()).now;
await page.waitForTimeout(3500);
s = await state();
self = myDeaths(s.ev).find((e) => e.t >= t0);
const shownAfterDeath = s.cards.some((x) => x.t >= t0 && x.t < restartAt && !x.hidden);
const hid = s.cards.find((x) => x.t >= restartAt && x.hidden);
check(
  !!self && shownAfterDeath && !hid,
  `round start: card shown and still up 3.5 s after the restart${hid ? ` (hidden ${((hid.t - restartAt) / 1000).toFixed(1)} s after it)` : ''}`
);

console.log(failures ? `${failures} FAILED` : 'all ok');
await browser.close();
process.exit(failures ? 1 : 0);
