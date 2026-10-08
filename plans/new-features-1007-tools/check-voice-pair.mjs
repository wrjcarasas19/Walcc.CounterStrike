// A.2: two players in the game hear each other, and how long it takes.
//
// usage: pw.sh check-voice-pair.mjs
//   Joins "VoiceA" and "VoiceB" (two browsers of one process, so they share
//   a clock; two pages of one browser share its GPU process and the second
//   engine starves) with Chromium's fake microphone. Through the page's own
//   Xash3DWebRTC (window.__engine): onVoiceTrack and onVoiceLane are
//   recorded from the start (set as soon as the engine object exists).
//   A talks 5 s with the fake mic (setMicTrack), then B: the other's lanes
//   get the RTP (inbound-rtp per lane mid), onVoiceLane says who is on the
//   lane and that it went quiet. The delay is measured without the engine
//   (check-voice-delay.mjs): two SwiftShader engines on this machine starve
//   the browsers' audio threads.
import { chromium } from '../new-features-1006-tools/node_modules/playwright/index.mjs';
import {
  newPage,
  joinGame,
  waitForPlayer,
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

// Runs in the page: records onVoiceTrack / onVoiceLane from the start.
function recordVoice() {
  window.__voice = { tracks: [], lanes: [] };
  const timer = setInterval(() => {
    const e = window.__engine;
    if (!e) return;
    clearInterval(timer);
    e.onVoiceTrack = (lane, track) =>
      window.__voice.tracks.push({ lane, track });
    e.onVoiceLane = (lane, userid) =>
      window.__voice.lanes.push({ t: Date.now(), lane, userid });
  }, 20);
}

const pages = {};
const browsers = [];
for (const name of ['VoiceA', 'VoiceB']) {
  const browser = await launch();
  browsers.push(browser);
  const page = await newPage(browser, { tag: name });
  await page.context().grantPermissions(['microphone']);
  await page.context().addInitScript(recordVoice);
  await joinGame(page, { name });
  await waitForPlayer(name);
  pages[name] = page;
}
const A = pages.VoiceA;
const B = pages.VoiceB;

const laneStats = (page) =>
  page.evaluate(async () => {
    const e = window.__engine;
    const lanes = e.laneMids.map(() => 0);
    let out = 0;
    (await e.peer.getStats()).forEach((r) => {
      if (r.type === 'inbound-rtp') {
        const lane = e.laneMids.indexOf(r.mid);
        if (lane >= 0) lanes[lane] = r.packetsReceived ?? 0;
      }
      if (r.type === 'outbound-rtp') out += r.packetsSent ?? 0;
    });
    return { lanes, out };
  });
const tracksOf = (page) =>
  page.evaluate(() => window.__voice.tracks.map((t) => t.lane));
const lanesOf = (page) =>
  page.evaluate(() =>
    window.__voice.lanes.map(({ lane, userid }) => ({ lane, userid })),
  );

console.log('A onVoiceTrack lanes:', JSON.stringify(await tracksOf(A)));
console.log('B onVoiceTrack lanes:', JSON.stringify(await tracksOf(B)));

const fakeMic = (page, on) =>
  page.evaluate(async (on) => {
    const e = window.__engine;
    if (!on) {
      await e.setMicTrack(null);
      window.__mic?.getTracks().forEach((t) => t.stop());
      return true;
    }
    window.__mic = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1 },
    });
    return e.setMicTrack(window.__mic.getAudioTracks()[0]);
  }, on);

for (const [talker, listener, tn, ln] of [
  [A, B, 'A', 'B'],
  [B, A, 'B', 'A'],
]) {
  const before = await laneStats(listener);
  const sentBefore = await laneStats(talker);
  console.log(`${tn} talks (fake mic):`, await fakeMic(talker, true));
  await talker.waitForTimeout(5000);
  await fakeMic(talker, false);
  await talker.waitForTimeout(1000);
  const after = await laneStats(listener);
  const sentAfter = await laneStats(talker);
  console.log(
    `  ${tn} sent ${sentAfter.out - sentBefore.out} RTP packets; ${ln} got per lane ${JSON.stringify(after.lanes.map((n, i) => n - before.lanes[i]))}`,
  );
  console.log(
    `  ${ln} onVoiceLane so far: ${JSON.stringify(await lanesOf(listener))}`,
  );
}

for (const browser of browsers) await browser.close();
