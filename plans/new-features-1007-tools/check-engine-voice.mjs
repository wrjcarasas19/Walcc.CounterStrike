// A.0 spike: does the web engine's own voice chat (Xash3D FWGS voice_enable
// / +voicerecord, SDL2 audio capture -> getUserMedia) work in the browser?
//
// usage: pw.sh check-engine-voice.mjs talker|listener [ct|t]
//   talker:   joins as "VoiceTalker" (CT), turns voice on, holds
//             +voicerecord for 8 s with Chromium's fake microphone (a beep),
//             and compares data-channel bytes sent while idle and while
//             recording, then prints the engine's console lines about
//             voice (the engine prints to the page console). Env
//             VOICE_ENABLE=0 sets the client cvar to 0 first instead.
//   listener: joins as "VoiceListener" (CT, or T with `t`) and prints
//             data-channel bytes received per second for 180 s, so a talker
//             run at the same time shows whether the server forwards the
//             voice (and only to teammates).
// Run both at once: `ZIP_PORT=27091 ./pw.sh check-engine-voice.mjs listener &`
// then `./pw.sh check-engine-voice.mjs talker`.
// playwright is installed in the 1006 tools folder (pw.sh).
import { chromium } from '../new-features-1006-tools/node_modules/playwright/index.mjs';
import { newPage, joinGame, waitForPlayer, engineCommand } from '../new-features-1006-tools/lib.mjs';

const role = process.argv[2] ?? 'talker';
const name = role === 'listener' ? 'VoiceListener' : 'VoiceTalker';
// Optional team: ct (default) or t, e.g. a listener on the enemy team.
const team = process.argv[3] === 't' ? 1 : 2;

const browser = await chromium.launch({
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
const page = await newPage(browser, { tag: role });
const voiceLines = [];
page.on('console', (m) => {
  if (/voice|capture/i.test(m.text())) voiceLines.push(m.text());
});
await page.context().grantPermissions(['microphone']);
// Count getUserMedia calls and data-channel bytes both ways.
await page.context().addInitScript(() => {
  window.__voice = { gum: 0, gumOk: 0, gumErr: '', sentBytes: 0, recvBytes: 0 };
  const md = navigator.mediaDevices;
  if (md?.getUserMedia) {
    const gum = md.getUserMedia.bind(md);
    md.getUserMedia = (c) => {
      window.__voice.gum++;
      return gum(c).then(
        (s) => (window.__voice.gumOk++, s),
        (e) => {
          window.__voice.gumErr = String(e);
          throw e;
        }
      );
    };
  }
  const size = (d) => d.byteLength ?? d.size ?? d.length ?? 0;
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (data) {
    window.__voice.sentBytes += size(data);
    return send.call(this, data);
  };
  const Peer = window.RTCPeerConnection;
  const Wrapped = function (...args) {
    const peer = new Peer(...args);
    peer.addEventListener('datachannel', (e) =>
      e.channel.addEventListener('message', (m) => (window.__voice.recvBytes += size(m.data)))
    );
    return peer;
  };
  Wrapped.prototype = Peer.prototype;
  window.RTCPeerConnection = Wrapped;
});

const stats = () => page.evaluate(() => ({ ...window.__voice }));
async function rate(key, seconds) {
  const a = (await stats())[key];
  await page.waitForTimeout(seconds * 1000);
  return Math.round(((await stats())[key] - a) / seconds);
}

await joinGame(page, { name });
await waitForPlayer(name);
console.log('right after join:', JSON.stringify(await stats()));
await engineCommand(page, `jointeam ${team}`);
await page.waitForTimeout(1500);
await engineCommand(page, 'joinclass 1');
await page.waitForTimeout(3000);

if (role === 'listener') {
  console.log('listener in; bytes received per second:');
  for (let i = 0; i < 90; i++) console.log(`  t+${i * 2}s recv ${await rate('recvBytes', 2)} B/s`);
  await browser.close();
  process.exit(0);
}

await engineCommand(page, 'cvarlist voice');
await engineCommand(page, 'cmdlist voice');
// VOICE_ENABLE=0: check that the client cvar alone stops engine voice.
await engineCommand(page, `voice_enable ${process.env.VOICE_ENABLE ?? 1}`);
await engineCommand(page, 'voice_scale 1');
await engineCommand(page, 'voice_enable');
await engineCommand(page, 'sv_voiceenable');
await page.waitForTimeout(500);

console.log('before:', JSON.stringify(await stats()));
console.log('idle send rate:', await rate('sentBytes', 4), 'B/s');
await engineCommand(page, '+voicerecord');
await page.waitForTimeout(1000);
console.log('recording send rate:', await rate('sentBytes', 8), 'B/s');
console.log('after +voicerecord:', JSON.stringify(await stats()));
await engineCommand(page, '-voicerecord');
await page.waitForTimeout(1000);
console.log('idle again send rate:', await rate('sentBytes', 4), 'B/s');

console.log('engine console lines about voice:');
for (const l of voiceLines) console.log('  ' + l);
await browser.close();
