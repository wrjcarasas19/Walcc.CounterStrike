// A.3: who hears whom in a 2 v 2 of real game clients.
//
// usage: pw.sh check-voice-teams.mjs
//   Joins T1, T2 (Terrorists) and C1, C2 (CTs), one browser each (small
//   viewport, Chromium's fake microphone), restarts the round through the
//   admin API so all four are alive, then (sv_alltalk left at the
//   server's default, which must be 0):
//   1. T1 talks: T2 hears, the CTs don't. C1 talks: C2 hears, the Ts don't.
//   2. T1 talks and runs `kill` mid-sentence (DEATHS times, default 3,
//      with a round restart in between): T2 gets no more of T1's packets,
//      and when the lane was announced quiet, after the kill.
//      Then the dead T1 still hears the living T2, and T2 doesn't hear T1.
//   3. sv_alltalk 1 (admin API "cvar" action, as the Match tab sends it):
//      the dead T1 is heard by everyone, C1 by the Ts. Then sv_alltalk 0.
//   4. mp_timelimit 1 ends the map: C1 talks until the map changes and the
//      Ts hear them from the intermission on (the time of their first lane
//      event).
//   Each player's lane packets come from getStats (inbound-rtp per lane
//   mid), sampled every 25 ms in the page; lane events from onVoiceLane.
//   Start the server without bots (`run-server.sh de_dust2 0`). The
//   server's roster (who is T/CT, alive, the userids) is in its log only
//   with a debug build; the lane events' userids are printed here.
import { chromium } from '../new-features-1006-tools/node_modules/playwright/index.mjs';
import {
  newPage,
  joinGame,
  waitForPlayer,
  engineCommand,
  adminAction,
  BASE,
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

// Runs in the page: records lane events and samples lane packets.
function recordVoice() {
  window.__voice = { lanes: [], samples: [] };
  const timer = setInterval(() => {
    const e = window.__engine;
    if (!e || !e.peer) return;
    clearInterval(timer);
    e.onVoiceLane = (lane, userid) =>
      window.__voice.lanes.push({ t: Date.now(), lane, userid });
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
// sv_alltalk isn't set: the server's own default (server.cfg) must be 0.
console.log(
  'restart:',
  JSON.stringify(await adminAction({ action: 'restart' })),
);
await pages.T1.waitForTimeout(4000);

const fakeMic = (page, on) =>
  page.evaluate(async (on) => {
    const e = window.__engine;
    // Before the first packet can leave (the lane event comes with it).
    const start = Date.now();
    if (!on) {
      await e.setMicTrack(null);
      window.__mic?.getTracks().forEach((t) => t.stop());
      return true;
    }
    window.__mic = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1 },
    });
    await e.setMicTrack(window.__mic.getAudioTracks()[0]);
    return start;
  }, on);

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
// When the lane packets last went up before t1.
function lastPacket(v, t1) {
  let last;
  for (let i = 1; i < v.samples.length; i++) {
    const s = v.samples[i];
    if (s.t > t1) break;
    if (total(s) > total(v.samples[i - 1])) last = s.t;
  }
  return last;
}

async function talk(talker, seconds, label) {
  const t0 = await fakeMic(pages[talker], true);
  await pages[talker].waitForTimeout(seconds * 1000);
  await fakeMic(pages[talker], false);
  await pages[talker].waitForTimeout(1200);
  const t1 = t0 + seconds * 1000 + 600;
  const got = {};
  for (const n of names) {
    if (n === talker) continue;
    const v = await voiceOf(pages[n]);
    got[n] = {
      packets: received(v, t0, t1),
      events: v.lanes.filter((e) => e.t >= t0).map((e) => [e.lane, e.userid]),
    };
  }
  console.log(`${label}: ${talker} talks ${seconds} s ->`, JSON.stringify(got));
  return got;
}

let failures = 0;
const expect = (ok, what) => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const hears = (got, n) => got[n].packets > 50;
const silent = (got, n) => got[n].packets === 0 && got[n].events.length === 0;

// 1. Teams.
let g = await talk('T1', 4, 'alive, alltalk 0');
expect(
  hears(g, 'T2') && silent(g, 'C1') && silent(g, 'C2'),
  'T1 heard by T2 only',
);
const t1Userid = g.T2.events[0]?.[1];
g = await talk('C1', 4, 'alive, alltalk 0');
expect(
  hears(g, 'C2') && silent(g, 'T1') && silent(g, 'T2'),
  'C1 heard by C2 only',
);

// 2. Death mid-sentence, DEATHS times (a round restart in between). The
// quiet event is when T2's page handled it (an upper bound: the pages are
// starved by four SwiftShader engines, their getStats samples come in
// bursts too, so a packet's sample time can lag by a few hundred ms).
const DEATHS = Number(process.env.DEATHS ?? 3);
const quietTimes = [];
for (let trial = 1; trial <= DEATHS; trial++) {
  if (trial > 1) {
    await adminAction({ action: 'restart' });
    await pages.T1.waitForTimeout(4000);
  }
  const t0 = await fakeMic(pages.T1, true);
  await pages.T1.waitForTimeout(2000);
  const killAt = await pages.T1.evaluate(() => {
    window.__engine.Cmd_ExecuteString('kill');
    return Date.now();
  });
  await pages.T1.waitForTimeout(3000);
  await fakeMic(pages.T1, false);
  await pages.T1.waitForTimeout(1000);
  const v = await voiceOf(pages.T2);
  const before = received(v, t0, killAt);
  const after = received(v, killAt + 1000, killAt + 3000);
  const last = lastPacket(v, killAt + 3000);
  const quiet = v.lanes.find((e) => e.t >= killAt && e.userid === 0);
  const rel = (t) => t - killAt;
  const steps = [];
  for (let i = 1; i < v.samples.length; i++) {
    const s = v.samples[i];
    if (s.t < killAt - 300 || s.t > killAt + 1500) continue;
    const d = total(s) - total(v.samples[i - 1]);
    if (d) steps.push([rel(s.t), d]);
  }
  console.log(
    `death ${trial} (kill at ${new Date(killAt).toISOString()}): T2 got ${before} packets of T1 before the kill, ${after} from 1 s after it; last packet sampled ${last - killAt} ms after the kill; lane quiet event ${quiet ? `${rel(quiet.t)} ms` : 'none'} after it`,
  );
  console.log(
    '  T2 packet samples around the kill (ms after it, new packets):',
    JSON.stringify(steps),
  );
  expect(before > 50 && after === 0, 'T1 silent for T2 after dying');
  expect(quiet && rel(quiet.t) < 500, 'quiet event within 0.5 s');
  if (quiet) quietTimes.push(rel(quiet.t));
  for (const n of ['C1', 'C2']) {
    const vc = await voiceOf(pages[n]);
    expect(received(vc, t0, killAt + 3000) === 0, `${n} never heard T1`);
  }
}
console.log(`quiet events after the kill (ms): ${JSON.stringify(quietTimes)}`);
g = await talk('T2', 3, 'T1 dead');
expect(
  hears(g, 'T1') && silent(g, 'C1') && silent(g, 'C2'),
  "dead T1 hears living T2; CTs don't",
);
g = await talk('T1', 3, 'T1 dead');
expect(
  silent(g, 'T2') && silent(g, 'C1') && silent(g, 'C2'),
  'dead T1 heard by nobody alive',
);

// 3. sv_alltalk 1.
console.log(
  'alltalk 1:',
  JSON.stringify(
    await adminAction({ action: 'cvar', name: 'sv_alltalk', value: 1 }),
  ),
);
await pages.T1.waitForTimeout(1000);
g = await talk('T1', 3, 'alltalk 1');
expect(
  hears(g, 'T2') && hears(g, 'C1') && hears(g, 'C2'),
  'dead T1 heard by everyone',
);
const t1UseridAll = g.C1.events[0]?.[1];
g = await talk('C1', 3, 'alltalk 1');
expect(
  hears(g, 'T1') && hears(g, 'T2') && hears(g, 'C2'),
  'C1 heard by everyone',
);
console.log(
  'alltalk 0:',
  JSON.stringify(
    await adminAction({ action: 'cvar', name: 'sv_alltalk', value: 0 }),
  ),
);
await pages.T1.waitForTimeout(1000);
g = await talk('C1', 3, 'alltalk 0 again');
expect(
  hears(g, 'C2') && silent(g, 'T1') && silent(g, 'T2'),
  'C1 heard by C2 only again',
);
expect(
  t1Userid > 0 && t1Userid === t1UseridAll,
  `T1's userid the same for T2 and C1 (${t1Userid}, ${t1UseridAll})`,
);

// 4. Intermission: a 1 minute time limit ends the map (it has run longer).
// AMX Mod X's mapchooser votes for the next map first, so the scoreboard
// (mp_chattime) comes some 10-25 s later; C1 talks all along, and the Ts
// (enemies, sv_alltalk 0) may only hear them from the intermission on.
// Then the map changes.
{
  const setAt = Date.now();
  console.log(
    'time limit 1:',
    JSON.stringify(
      await adminAction({ action: 'cvar', name: 'mp_timelimit', value: 1 }),
    ),
  );
  const t0 = await fakeMic(pages.C1, true);
  const map0 = (await (await fetch(`${BASE}/status.json`)).json()).map;
  // Until the map changes (the server stops answering for a moment, or
  // the players drop out of status.json), at most 45 s.
  let changedAt;
  while (Date.now() - setAt < 45_000) {
    await pages.C1.waitForTimeout(500);
    const st = await fetch(`${BASE}/status.json`)
      .then((r) => r.json())
      .catch(() => null);
    if (!st || st.map !== map0 || st.players.length < 4) {
      changedAt = Date.now();
      break;
    }
  }
  await fakeMic(pages.C1, false).catch(() => {});
  const end = changedAt ?? Date.now();
  const got = {};
  for (const n of ['T1', 'T2', 'C2']) {
    const v = await voiceOf(pages[n]);
    const first = v.lanes.find((e) => e.t >= t0 && e.userid > 0);
    got[n] = {
      packets: received(v, t0, end),
      firstLane: first ? `${Math.round((first.t - setAt) / 100) / 10} s` : null,
    };
  }
  console.log(
    `intermission: C1 talked from the time limit until the map change (${changedAt ? `${Math.round((changedAt - setAt) / 100) / 10} s` : 'not seen'}) ->`,
    JSON.stringify(got),
  );
  expect(
    got.T1.packets > 50 && got.T2.packets > 50 && got.C2.packets > 50,
    'C1 heard by the Ts during the intermission',
  );
}

console.log(failures ? `${failures} FAILED` : 'all OK');
for (const browser of browsers) await browser.close();
process.exit(failures ? 1 : 0);
