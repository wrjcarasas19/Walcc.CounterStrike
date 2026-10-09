// A.7: talk to all players, in a 2 v 2 of real game clients.
//
// usage: pw.sh check-voice-all.mjs
//   Start the server without bots (`run-server.sh de_dust2 0`). Joins T1,
//   T2 (Terrorists) and C1, C2 (CTs), one browser each (small viewport,
//   Chromium's fake microphone), restarts the round so all four are alive,
//   then, through real key presses (voice.ts), not setMicTrack by hand:
//   1. T1 holds L (voiceAllKey, default): T2 (teammate) and the CTs
//      (enemies) all get T1's RTP and an onVoiceLane event with all:true;
//      the "[All]" tag shows in T1's own speaking-list entry and in C1's
//      speaking list and scoreboard cell for T1.
//   2. T1 holds K (voiceKey, the team-only key): only T2 hears; the CTs
//      get nothing and no all:true event, confirming K stays team-only
//      once the all key exists.
//   3. C2 is killed (`kill`), then holds L: T1, T2 and C1 (the living) get
//      nothing from the dead C2 talking to all (the CS 1.6 rule: alive
//      players never hear the dead, even in all mode).
//   4. wc_voice_all 0 (admin API "cvar" action, as the Match tab sends it):
//      T1 holds L reaches only T2 (the CTs are silent); wc_voice_all 1
//      reopens it.
//   Lane packets come from getStats (inbound-rtp per lane mid), sampled
//   every 25 ms in the page; lane events (with `all`) from onVoiceLane.
//   Prints OK / FAIL per check.
import { chromium } from '../new-features-1006-tools/node_modules/playwright/index.mjs';
import {
  newPage,
  joinGame,
  waitForPlayer,
  engineCommand,
  adminAction,
  shot,
} from '../new-features-1006-tools/lib.mjs';

const launch = () =>
  chromium.launch({
    headless: true,
    channel: 'chromium',
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });

// Runs in the page: records lane events (with `all`) and samples lane
// packets, like check-voice-teams.mjs's recordVoice.
function recordVoice() {
  window.__voice = { lanes: [], samples: [] };
  const timer = setInterval(() => {
    const e = window.__engine;
    if (!e || !e.peer) return;
    clearInterval(timer);
    // Chained, not replaced: voice.ts's own initVoice() also sets this
    // single-slot hook (to drive the real speaking list/scoreboard), and
    // whichever assignment runs last would otherwise win, silently
    // breaking the app's own lane tracking on every page.
    const prevOnVoiceLane = e.onVoiceLane;
    e.onVoiceLane = (lane, userid, all) => {
      window.__voice.lanes.push({ t: Date.now(), lane, userid, all: !!all });
      prevOnVoiceLane?.(lane, userid, all);
    };
    setInterval(async () => {
      if (!e.laneMids) return;
      const lanes = e.laneMids.map(() => 0);
      (await e.peer.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp') {
          const lane = e.laneMids.indexOf(r.mid);
          if (lane >= 0) lanes[lane] = r.packetsReceived ?? 0;
        }
      });
      const s = window.__voice.samples;
      s.push({ t: Date.now(), lanes });
      if (s.length > 4000) s.splice(0, 1000);
    }, 25);
  }, 20);
}

const teams = { T1: 1, T2: 1, C1: 2, C2: 2 };
const pages = {};
const browsers = [];
for (const name of Object.keys(teams)) {
  const browser = await launch();
  browsers.push(browser);
  const page = await newPage(browser, { tag: name, width: 640, height: 400 });
  await page.context().grantPermissions(['microphone']);
  await page.context().addInitScript(recordVoice);
  await joinGame(page, { name });
  await waitForPlayer(name);
  await engineCommand(page, `jointeam ${teams[name]}`);
  await page.waitForTimeout(1000);
  await engineCommand(page, 'joinclass 1');
  await page.waitForTimeout(2000);
  await page.mouse.click(320, 200); // focus the page (a user gesture for audio)
  pages[name] = page;
  console.log(`${name} joined team ${teams[name] === 1 ? 'T' : 'CT'}`);
}
const names = Object.keys(pages);

console.log(
  'round time 9:',
  JSON.stringify(
    await adminAction({ action: 'cvar', name: 'mp_roundtime', value: 9 }),
  ),
);
console.log(
  'freeze time 0:',
  JSON.stringify(
    await adminAction({ action: 'cvar', name: 'mp_freezetime', value: 0 }),
  ),
);
console.log(
  'restart:',
  JSON.stringify(await adminAction({ action: 'restart' })),
);
await pages.T1.waitForTimeout(4000);

const voiceOf = (page) => page.evaluate(() => window.__voice);
const total = (s) => (s ? s.lanes.reduce((a, b) => a + b, 0) : 0);
// Packets received on all lanes between t0 and t1 (page clock = host clock).
function received(v, t0, t1) {
  const at = (t) => {
    let best;
    for (const s of v.samples) if (s.t <= t) best = s;
    return total(best);
  };
  return at(t1) - at(t0);
}

// The speaking list's entries: name, whether the [All] tag shows, and
// whether it's the local player's own entry.
async function speakingList(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('#hud-voice .hud-voice-entry')].map(
      (el) => ({
        name: el.querySelector('.hud-voice-name')?.textContent,
        all: !!el.querySelector('.hud-voice-all'),
        local: el.className.includes('local'),
      }),
    ),
  );
}

// The scoreboard's voice cell for name: whether it's shown speaking, and
// whether its [All] tag shows.
async function scoreVoice(page, name) {
  return page.evaluate((name) => {
    for (const row of document.querySelectorAll(
      '#hud-scoreboard .sb-row:not(.sb-labels)',
    )) {
      if (row.querySelector('.sb-name')?.textContent !== name) continue;
      const cell = row.querySelector('.sb-voice');
      return {
        speaking: !!cell?.querySelector('.sb-voice-icon.speaking'),
        all: !!cell?.querySelector('.sb-voice-all'),
      };
    }
    return null;
  }, name);
}

async function withScoreboard(page, fn) {
  await page.keyboard.down('Tab');
  await page.waitForTimeout(1200);
  try {
    return await fn();
  } finally {
    await page.keyboard.up('Tab');
    await page.waitForTimeout(300);
  }
}

// Four real game engines (T1, T2, C1, C2) share this host's cores and
// starve each page's timers by hundreds of ms (seen throughout A.3/A.5's
// Progress notes); mid's DOM checks need the lane event and the scores
// snapshot to have actually reached and been rendered by the listener's
// starved page, so it runs comfortably later into the hold than a single
// pair of clients would need (confirmed instant, <300 ms, with just two).
const MID_DELAY_MS = 2200;

// Holds key on talker's page for seconds (plus the release tail); mid, if
// given, is called MID_DELAY_MS into the hold (so its own DOM/scoreboard
// checks see a fresh speaking entry) and its result is returned as
// domDuring. Returns each listener's packets and lane events (with `all`)
// in the hold's real time window.
async function talk(talker, key, seconds, label, { mid } = {}) {
  const page = pages[talker];
  const t0 = Date.now();
  await page.keyboard.down(key);
  let domDuring;
  if (mid) {
    await page.waitForTimeout(MID_DELAY_MS);
    domDuring = await mid();
    await page.waitForTimeout(Math.max(200, seconds * 1000 - MID_DELAY_MS));
  } else {
    await page.waitForTimeout(seconds * 1000);
  }
  await page.keyboard.up(key);
  await page.waitForTimeout(1200);
  const t1 = Date.now();
  const got = {};
  for (const n of names) {
    if (n === talker) continue;
    const v = await voiceOf(pages[n]);
    got[n] = {
      packets: received(v, t0, t1),
      events: v.lanes
        .filter((e) => e.t >= t0)
        .map((e) => [e.lane, e.userid, e.all]),
    };
  }
  console.log(
    `${label}: ${talker} holds ${key} ${seconds}s ->`,
    JSON.stringify(got),
  );
  return { got, domDuring };
}

let failures = 0;
const expect = (ok, what) => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const hears = (got, n) => got[n].packets > 50;
const silent = (got, n) => got[n].packets === 0 && got[n].events.length === 0;
const allHears = (got, n) =>
  hears(got, n) && got[n].events.some((e) => e[2] === true);

// Warm-up press (the first one asks for the microphone; permission is
// already granted, so this only pays the getUserMedia + setMicTrack
// latency, as in check-voice-teams.mjs / check-voice-ptt.mjs).
await talk('T1', 'l', 1.5, 'warm-up');

// 1. T1 holds L: heard by T2 and both CTs, with all:true, and the [All]
// tag shows on T1's own speaking entry and on C1's view of T1 (list and
// scoreboard).
let { got, domDuring } = await talk('T1', 'l', 5, 'talk all', {
  mid: async () => {
    const self = (await speakingList(pages.T1)).find((e) => e.local);
    const listener = (await speakingList(pages.C1)).find(
      (e) => e.name === 'T1',
    );
    const score = await withScoreboard(pages.C1, async () => {
      const row = await scoreVoice(pages.C1, 'T1');
      await shot(pages.C1, 'a7-all-tag-scoreboard');
      return row;
    });
    await shot(pages.T1, 'a7-all-tag-self');
    return { self, listener, score };
  },
});
expect(
  allHears(got, 'T2') && allHears(got, 'C1') && allHears(got, 'C2'),
  'T1 holding L is heard by T2 and the CTs, all:true',
);
expect(
  domDuring.self?.all === true,
  `T1's own speaking entry shows [All] (${JSON.stringify(domDuring.self)})`,
);
expect(
  domDuring.listener?.all === true,
  `C1's speaking list shows [All] for T1 (${JSON.stringify(domDuring.listener)})`,
);
expect(
  domDuring.score?.speaking && domDuring.score?.all,
  `C1's scoreboard shows the [All] tag for T1 (${JSON.stringify(domDuring.score)})`,
);

// 2. T1 holds K: team only, even with the all key existing.
({ got } = await talk('T1', 'k', 3, 'talk team'));
expect(
  hears(got, 'T2') &&
    !got.T2.events.some((e) => e[2] === true) &&
    silent(got, 'C1') &&
    silent(got, 'C2'),
  'T1 holding K is heard by T2 only, all:false',
);

// 3. C2 dies, then holds L: the living (T1, T2, C1) hear nothing.
await pages.C2.evaluate(() => window.__engine.Cmd_ExecuteString('kill'));
await pages.C2.waitForTimeout(1500);
({ got } = await talk('C2', 'l', 3, 'dead talks all'));
expect(
  silent(got, 'T1') && silent(got, 'T2') && silent(got, 'C1'),
  'dead C2 holding L is not heard by the living',
);

// 4. wc_voice_all 0: T1's L reaches the team only; 1 reopens it.
console.log(
  'wc_voice_all 0:',
  JSON.stringify(
    await adminAction({ action: 'cvar', name: 'wc_voice_all', value: 0 }),
  ),
);
await pages.T1.waitForTimeout(1000);
({ got } = await talk('T1', 'l', 3, 'wc_voice_all 0'));
expect(
  hears(got, 'T2') && silent(got, 'C1') && silent(got, 'C2'),
  'wc_voice_all 0: T1 holding L reaches T2 only',
);
console.log(
  'wc_voice_all 1:',
  JSON.stringify(
    await adminAction({ action: 'cvar', name: 'wc_voice_all', value: 1 }),
  ),
);
await pages.T1.waitForTimeout(1000);
({ got } = await talk('T1', 'l', 3, 'wc_voice_all 1 again'));
expect(
  allHears(got, 'T2') && allHears(got, 'C1'),
  'wc_voice_all 1: T1 holding L reaches the CTs again',
);

console.log(failures ? `${failures} FAILED` : 'all OK');
for (const browser of browsers) await browser.close();
process.exit(failures ? 1 : 0);
