// A.3: what the 250 ms roster poll costs a player in the game.
//
// usage: pw.sh check-voice-roster-cost.mjs [seconds]
//   Joins "Cost" (CT) and stays for [seconds] (default 60) without
//   talking. With voice on the player is in the voice hub, so the server
//   reads wc_roster through its console 4 times a second; with VOICE=0 it
//   never does. Prints, per second, the game packets the page received
//   (the server's updates: a slower server frame sends fewer) and the ICE
//   round trip, then their mean. Run once against each server and compare
//   (voice-roster-cost.sh does both and adds the server's CPU).
import { chromium } from '../new-features-1006-tools/node_modules/playwright/index.mjs';
import {
  newPage,
  joinGame,
  waitForPlayer,
  engineCommand,
} from '../new-features-1006-tools/lib.mjs';

const seconds = Number(process.argv[2] ?? 60);
const browser = await chromium.launch({
  headless: true,
  channel: 'chromium',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});
const page = await newPage(browser, { tag: 'Cost', width: 640, height: 400 });
await page.context().grantPermissions(['microphone']);
await joinGame(page, { name: 'Cost' });
await waitForPlayer('Cost');
await engineCommand(page, 'jointeam 2');
await page.waitForTimeout(1000);
await engineCommand(page, 'joinclass 1');
await page.waitForTimeout(5000);
console.log(`START ${Date.now()}`);

const sample = () =>
  page.evaluate(async () => {
    let rtt;
    (await window.__engine.peer.getStats()).forEach((r) => {
      if (
        r.type === 'candidate-pair' &&
        r.nominated &&
        r.currentRoundTripTime !== undefined
      ) {
        rtt = r.currentRoundTripTime * 1000;
      }
    });
    return {
      received: window.__dc.received,
      rtt,
      voice: window.__engine.voiceAvailable,
    };
  });

let last = await sample();
const rows = [];
for (let i = 0; i < seconds; i++) {
  await page.waitForTimeout(1000);
  const s = await sample();
  rows.push({ pps: s.received - last.received, rtt: s.rtt });
  last = s;
}
console.log(`END ${Date.now()}`);
console.log('voice available:', last.voice);
console.log(
  'per second (game packets received, ICE RTT ms):',
  JSON.stringify(
    rows.map((r) => [
      r.pps,
      r.rtt === undefined ? null : Math.round(r.rtt * 10) / 10,
    ]),
  ),
);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const rtts = rows.map((r) => r.rtt).filter((x) => x !== undefined);
console.log(
  `mean: ${mean(rows.map((r) => r.pps)).toFixed(1)} packets/s, RTT ${rtts.length ? mean(rtts).toFixed(1) : '?'} ms (max ${rtts.length ? Math.max(...rtts).toFixed(1) : '?'})`,
);
await browser.close();
