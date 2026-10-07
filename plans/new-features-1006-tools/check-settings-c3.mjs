// C.3 announcer settings in headless Chromium against the image:
// - the Sound group of the settings panel has Announcer volume, Announce
//   headshots and Hear other players' first blood; changes persist across a
//   reload;
// - at volume 0: no sound file is fetched after joining, no live `scores`
//   while the scoreboard is closed, a real first blood by bots only shows
//   the toast; turning the volume up in game (F3) loads the 16 sounds and
//   starts live scores;
// - "Hear other players' first blood" off: the bots' first blood has its
//   toast but no sound; on: it plays;
// - "Announce headshots" off / on with a synthetic headshot kill;
// - volume 0 in game again: a sound is "dropped (volume 0)".
// The page logs "announcer: ..." with console.debug for every play / drop.
// usage: ./run-server.sh de_dust2 4 && ./pw.sh check-settings-c3.mjs
// Leaves the server without bots.
import {
  BASE,
  adminAction,
  joinGame,
  launch,
  newPage,
  pressKey,
  shot,
  waitForPlayer,
} from './lib.mjs';

const NAME = 'SetCheck';
let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

await adminAction({ action: 'bot_quota', players: 4 });

const browser = await launch();
const page = await newPage(browser, { tag: 'c3' });
const soundRequests = [];
page.on('request', (r) => {
  if (new URL(r.url()).pathname.startsWith('/sounds/')) soundRequests.push(r.url());
});
const logs = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (text.startsWith('announcer:')) {
    logs.push(text);
    console.log(`  [${msg.type()}] ${text}`);
  }
});
const waitLog = async (re, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = logs.find((l) => re.test(l));
    if (hit) return hit;
    await page.waitForTimeout(250);
  }
  return undefined;
};

const IDS = {
  volume: '#setting-announcerVolume',
  headshots: '#setting-announcerHeadshots',
  others: '#setting-announcerOthers',
};
const setVolume = (value) =>
  page.evaluate(
    ([sel, v]) => {
      const input = document.querySelector(sel);
      input.value = String(v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    [IDS.volume, value]
  );
const setToggle = (sel, on) =>
  page.evaluate(
    ([s, want]) => {
      const input = document.querySelector(s);
      if (input.checked !== want) input.click();
    },
    [sel, on]
  );
const controls = () =>
  page.evaluate((ids) => {
    const v = document.querySelector(ids.volume);
    return {
      volume: v && Number(v.value),
      volumeText: v?.closest('.settings-field')?.querySelector('output')?.textContent,
      headshots: document.querySelector(ids.headshots)?.checked,
      others: document.querySelector(ids.others)?.checked,
      group: v?.closest('.settings-group')?.getAttribute('aria-label'),
      visible: !!v?.offsetParent,
      labels: [ids.headshots, ids.others].map(
        (s) => document.querySelector(s)?.closest('label')?.textContent
      ),
      saved: JSON.parse(localStorage.getItem('player-settings') ?? '{}'),
    };
  }, IDS);

// Login page: the panel, then volume 0 + both toggles off, then a reload.
await page.goto(BASE);
await page.waitForTimeout(3000);
await page.click('#settings-launcher-button');
await page.waitForTimeout(500);
let c = await controls();
console.log('  login panel:', JSON.stringify(c));
check(
  c.visible && c.group === 'Sound' && c.volume === 70 && c.headshots && c.others,
  'Sound group shows the announcer controls with defaults 70 / on / on'
);
await shot(page, 'c3-login-settings');
await setVolume(0);
await setToggle(IDS.headshots, false);
await setToggle(IDS.others, false);
await page.reload();
await page.waitForTimeout(3000);
c = await controls();
check(
  c.volume === 0 && c.volumeText === '0%' && c.headshots === false && c.others === false &&
    c.saved.announcerVolume === 0 && c.saved.announcerHeadshots === false &&
    c.saved.announcerOthers === false,
  `after reload: ${JSON.stringify({ ...c, labels: undefined })}`
);

// Join at volume 0.
await joinGame(page, { name: NAME });
await waitForPlayer(NAME);
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
  new MutationObserver(() => window.__toasts.push(toast.textContent)).observe(toast, {
    childList: true,
    characterData: true,
    subtree: true,
  });
});
const scoresIn = async (ms) => {
  const before = await page.evaluate(() => window.__events.scores ?? 0);
  await page.waitForTimeout(ms);
  return (await page.evaluate(() => window.__events.scores ?? 0)) - before;
};
const waitToast = async (ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const t = await page.evaluate(() => window.__toasts.find((x) => / drew first blood$/.test(x)));
    if (t) return t;
    await page.waitForTimeout(500);
  }
  return undefined;
};
const firstBloodRound = async () => {
  logs.length = 0;
  await page.evaluate(() => (window.__toasts = []));
  console.log('restart:', (await adminAction({ action: 'restart' })).status);
  const toast = await waitToast(150_000);
  await page.waitForTimeout(1000);
  return toast;
};

check(
  logs.includes('announcer: off (volume 0), sounds not loaded'),
  `volume 0 at start: ${logs.join(' | ')}`
);
await page.waitForTimeout(5000);
check(soundRequests.length === 0, `volume 0: ${soundRequests.length} sound requests after joining`);
let n = await scoresIn(5000);
check(n === 0, `volume 0: ${n} scores events in 5 s with the scoreboard closed`);
let toast = await firstBloodRound();
check(
  !!toast && !logs.some((l) => /play/.test(l)),
  `volume 0: first blood toast "${toast}", logs: ${logs.join(' | ') || '(none)'}`
);

// Volume up in game (F3): the sounds load now, live scores start.
logs.length = 0;
await pressKey(page, 'F3');
c = await controls();
check(c.visible && c.volume === 0, 'F3 in game shows the announcer volume at 0');
await shot(page, 'c3-game-settings');
await setVolume(60);
const loaded = await waitLog(/loaded \d+\/16/, 30_000);
check(loaded === 'announcer: loaded 16/16 sounds (.webm)', `volume 60: ${loaded}`);
check(soundRequests.length === 16, `${soundRequests.length} sound requests`);
await pressKey(page, 'F3');
await page.keyboard.press('Shift');
n = await scoresIn(5000);
check(n > 5, `volume 60: ${n} scores events in 5 s with the scoreboard closed`);

// Other players' first blood: off, then on.
toast = await firstBloodRound();
check(
  !!toast && !logs.some((l) => /play first-blood/.test(l)),
  `others off: toast "${toast}", logs: ${logs.join(' | ') || '(none)'}`
);
await pressKey(page, 'F3');
await setToggle(IDS.others, true);
await pressKey(page, 'F3');
toast = await firstBloodRound();
check(
  !!toast && logs.some((l) => /play first-blood/.test(l)),
  `others on: toast "${toast}", logs: ${logs.join(' | ') || '(none)'}`
);

// Bots out, so no new round (and first blood) during the synthetic part.
console.log('bots out:', (await adminAction({ action: 'bot_kick_all' })).status);
await adminAction({ action: 'bot_quota', players: 0 });
await page.waitForTimeout(5000);

const send = (type, payload) =>
  page.evaluate(([t, p]) => window.__engine.em.Module.hudEvent(t, p), [type, payload]);
let victim = 0;
const hsKill = () =>
  send('kill', {
    killer: NAME,
    victim: `Fake${++victim}`,
    weapon: 'ak47',
    headshot: true,
    killerTeam: 'T',
    victimTeam: 'CT',
  });
// A round start (e.g. after the kick) reopens first blood, and the player's
// own first blood beats a headshot: let someone else take it first.
const takeFirstBlood = async () => {
  await send('kill', {
    killer: 'Other1',
    victim: 'Other2',
    weapon: 'ak47',
    headshot: false,
    killerTeam: 'CT',
    victimTeam: 'T',
  });
  await page.waitForTimeout(3000);
};
await takeFirstBlood();
logs.length = 0;
await hsKill();
await page.waitForTimeout(1500);
check(!logs.some((l) => /headshot/.test(l)), `headshots off: ${logs.join(' | ') || '(none)'}`);
await page.waitForTimeout(4500); // past the multi-kill window
await pressKey(page, 'F3');
await setToggle(IDS.headshots, true);
await pressKey(page, 'F3');
await takeFirstBlood();
logs.length = 0;
await hsKill();
await page.waitForTimeout(1500);
check(logs.includes('announcer: play headshot'), `headshots on: ${logs.join(' | ') || '(none)'}`);

// Volume 0 again: dropped, live scores off.
await page.waitForTimeout(4500);
await pressKey(page, 'F3');
await setVolume(0);
await pressKey(page, 'F3');
logs.length = 0;
await hsKill();
await page.waitForTimeout(1000);
check(
  logs.includes('announcer: headshot dropped (volume 0)') && !logs.some((l) => /play/.test(l)),
  `volume 0 in game: ${logs.join(' | ') || '(none)'}`
);
n = await scoresIn(5000);
check(n === 0, `volume 0 in game: ${n} scores events in 5 s`);

// Persisted across a reload.
await page.reload();
await page.waitForTimeout(3000);
c = await controls();
check(
  c.saved.announcerVolume === 0 && c.saved.announcerHeadshots === true &&
    c.saved.announcerOthers === true && c.volume === 0 && c.headshots && c.others,
  `after the second reload: ${JSON.stringify(c.saved)}`
);

console.log(failures ? `${failures} FAILED` : 'all passed');
await browser.close();
process.exit(failures ? 1 : 0);
