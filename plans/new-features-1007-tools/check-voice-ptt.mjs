// A.4: push to talk and the voice settings, through the real page.
//
// usage: pw.sh check-voice-ptt.mjs
//   Start the server without bots (`run-server.sh de_dust2 0`). Joins
//   "PttA" (desktop, fake microphone allowed) and "PttB" (desktop,
//   microphone permission denied through CDP), both CT, one browser each.
//   1. A: no getUserMedia call before the first press; the engine's
//      voice_enable is 0 and K is unbound.
//   2. A holds K 4 s: getUserMedia once, RTP goes out, B gets it on a lane
//      and plays it (level after B's master gain); the game data channel
//      sends no more than when idle (the engine's own voice would add ~4 KB/s).
//   3. A lets go: the mic sender's track goes null about 200 ms after the
//      keyup, and RTP stops.
//   4. A opens the chat (Y) and presses K: "k" is typed, nothing is sent.
//   5. B sets its voice volume to 0 (settings panel): A's voice plays at 0.
//   6. B (permission denied) presses K: "Microphone blocked" notice, and the
//      settings' Voice group shows the help.
//   7. A turns voice off in the settings and presses K: no getUserMedia,
//      no RTP; on again.
//   8. Settings on the login page of a new page (B's browser, no fake UI):
//      only the default microphone is listed before the permission; after
//      it the microphone test shows a level and the microphones are listed;
//      values changed in the panel survive a reload.
//   9. A leaves; "PttC" joins on a touch phone viewport (844x390, isMobile,
//      hasTouch): the microphone button shows (screenshot), no
//      getUserMedia before it is held, holding it (CDP touch events) sends
//      and B hears it, letting go stops.
// `pw.sh check-voice-ptt.mjs novoice`, against a server with VOICE=0: A
// holds K and nothing asks for the microphone.
// Prints OK / FAIL per check.
import { chromium } from '../new-features-1006-tools/node_modules/playwright/index.mjs';
import {
  newPage,
  joinGame,
  waitForPlayer,
  engineCommand,
  shot,
  BASE,
} from '../new-features-1006-tools/lib.mjs';

const launch = (fakeUi = true) =>
  chromium.launch({
    headless: true,
    channel: 'chromium',
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      ...(fakeUi ? ['--use-fake-ui-for-media-stream'] : []),
    ],
  });

let failures = 0;
function check(ok, text) {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${text}`);
}

// Runs in the page before its scripts: counts getUserMedia calls and game
// data channel bytes, records the talk key's keyup time (this listener is
// registered first, voice.ts stops the keyup from going further), lane
// events, the mic sender's track changes, and voice.ts's master gain.
function instrument() {
  const v = (window.__ptt = {
    gum: 0,
    dcBytes: 0,
    keyups: [],
    lanes: [],
    micTrack: [],
    master: undefined,
    console: [],
  });
  const md = navigator.mediaDevices;
  const gum = md.getUserMedia.bind(md);
  md.getUserMedia = (c) => {
    v.gum++;
    return gum(c);
  };
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (data) {
    if (this.label === 'game') v.dcBytes += data.byteLength ?? data.size ?? 0;
    return send.call(this, data);
  };
  // A plain 200 ms timer started at each keyup shows how late the page's
  // timers run (SwiftShader engines starve it).
  window.addEventListener(
    'keyup',
    (e) => {
      const t = performance.now();
      const keyup = { code: e.code, t, timer: -1 };
      v.keyups.push(keyup);
      setTimeout(() => (keyup.timer = performance.now() - t), 200);
    },
    { capture: true }
  );
  // voice.ts's master gain: the gain connected to the context's speakers
  // in the context that also made a MediaStreamSource.
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (target, ...rest) {
    if (
      this instanceof GainNode &&
      target === this.context.destination &&
      !v.master
    ) {
      v.masterCandidate = this;
    }
    return connect.call(this, target, ...rest);
  };
  const source = AudioContext.prototype.createMediaStreamSource;
  AudioContext.prototype.createMediaStreamSource = function (stream) {
    if (v.masterCandidate?.context === this) v.master = v.masterCandidate;
    return source.call(this, stream);
  };
  const timer = setInterval(() => {
    const e = window.__engine;
    if (!e?.onVoiceLane) return;
    clearInterval(timer);
    const lane = e.onVoiceLane;
    e.onVoiceLane = (l, u) => {
      v.lanes.push({ t: performance.now(), lane: l, userid: u });
      lane(l, u);
    };
    const setMic = e.setMicTrack.bind(e);
    v.setMic = [];
    e.setMicTrack = (track) => {
      v.setMic.push({ t: performance.now(), on: !!track });
      return setMic(track);
    };
    let last = null;
    setInterval(() => {
      const track = e.mic?.sender.track ?? null;
      if (track !== last) {
        last = track;
        v.micTrack.push({ t: performance.now(), on: !!track });
      }
    }, 5);
  }, 5);
}

async function rtp(page) {
  return page.evaluate(async () => {
    const e = window.__engine;
    const lanes = (e.laneMids ?? []).map(() => 0);
    let out = 0;
    if (e.peer) {
      (await e.peer.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp') {
          const lane = e.laneMids.indexOf(r.mid);
          if (lane >= 0) lanes[lane] = r.packetsReceived ?? 0;
        }
        if (r.type === 'outbound-rtp') out += r.packetsSent ?? 0;
      });
    }
    return { out, in: lanes.reduce((a, b) => a + b, 0) };
  });
}
const ptt = (page) => page.evaluate(() => window.__ptt);
const dcBytes = async (page) => (await ptt(page)).dcBytes;

// Level after B's master gain (voice volume), 0..1 RMS, over ms.
async function playedLevel(page, ms) {
  return page.evaluate(async (ms) => {
    const master = window.__ptt.master;
    if (!master) return -1;
    const analyser = master.context.createAnalyser();
    analyser.fftSize = 2048;
    master.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let peak = 0;
    const end = performance.now() + ms;
    while (performance.now() < end) {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const x of data) sum += x * x;
      peak = Math.max(peak, Math.sqrt(sum / data.length));
      await new Promise((r) => setTimeout(r, 50));
    }
    master.disconnect(analyser);
    return peak;
  }, ms);
}

async function setRange(page, id, value) {
  await page.evaluate(
    ([id, value]) => {
      const input = document.getElementById(id);
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    [id, value]
  );
}

async function join(browser, name, opts = {}) {
  const page = await newPage(browser, { tag: name, ...opts });
  page.on('console', (m) => {
    if (/voice_enable|"k"|voice/i.test(m.text())) console.log(`  [${name}] ${m.text()}`);
  });
  await page.context().addInitScript(instrument);
  await joinGame(page, { name });
  await waitForPlayer(name);
  await engineCommand(page, 'jointeam 2');
  await page.waitForTimeout(1000);
  await engineCommand(page, 'joinclass 1');
  await page.waitForTimeout(3000);
  return page;
}

const origin = new URL(BASE).origin;

// --- A and B ---
const browserA = await launch();
if (process.argv[2] === 'novoice') {
  const A = await join(browserA, 'PttA');
  await A.mouse.click(640, 400);
  await A.keyboard.down('k');
  await A.waitForTimeout(2000);
  await A.keyboard.up('k');
  const { gum } = await ptt(A);
  const available = await A.evaluate(() => window.__engine.voiceAvailable);
  check(!available && gum === 0, `no voice on the server: voiceAvailable ${available}, getUserMedia ${gum}`);
  await browserA.close();
  process.exit(failures ? 1 : 0);
}
const A = await join(browserA, 'PttA');
await A.context().grantPermissions(['microphone'], { origin });

const browserB = await launch(false);
const B = await join(browserB, 'PttB');
{
  const cdp = await B.context().newCDPSession(B);
  await cdp.send('Browser.setPermission', {
    permission: { name: 'microphone' },
    setting: 'denied',
    origin,
  });
}

// 1. Nothing before the first press.
console.log('engine cvars on A:');
await engineCommand(A, 'voice_enable');
await engineCommand(A, 'bind k');
await A.waitForTimeout(500);
check((await ptt(A)).gum === 0, `A: no getUserMedia before the first press (${(await ptt(A)).gum})`);
check((await ptt(B)).gum === 0, `B: no getUserMedia before the first press (${(await ptt(B)).gum})`);

// 2. Hold K.
await A.mouse.click(640, 400); // focus the page (a user gesture for audio)
await B.mouse.click(640, 400);
await A.waitForTimeout(1000);
let a0 = await rtp(A);
let b0 = await rtp(B);
let d0 = await dcBytes(A);
await A.waitForTimeout(4000);
const idleRate = ((await dcBytes(A)) - d0) / 4;
const idleOut = (await rtp(A)).out - a0.out;

a0 = await rtp(A);
b0 = await rtp(B);
await A.keyboard.down('k');
await A.waitForTimeout(500);
d0 = await dcBytes(A);
const levelPromise = playedLevel(B, 3000);
await A.waitForTimeout(3500);
const talkRate = ((await dcBytes(A)) - d0) / 3.5;
let a1 = await rtp(A);
let b1 = await rtp(B);
const level80 = await levelPromise;
check((await ptt(A)).gum === 1, `A: getUserMedia once, on the first press (${(await ptt(A)).gum})`);
check(a1.out - a0.out > 150, `A: RTP sent while holding K: ${a1.out - a0.out} packets in 4 s (idle before: ${idleOut})`);
check(b1.in - b0.in > 150, `B: got ${b1.in - b0.in} lane packets`);
const laneEvents = (await ptt(B)).lanes;
check(laneEvents.some((e) => e.userid > 0), `B: lane events ${JSON.stringify(laneEvents.map((e) => [e.lane, e.userid]))}`);
check(level80 > 0.0005, `B: A's voice plays through the master gain (peak RMS ${level80.toFixed(4)})`);
check(
  talkRate < idleRate + 1000,
  `A: game data channel ${Math.round(idleRate)} B/s idle, ${Math.round(talkRate)} B/s holding K (engine voice would add ~4000)`
);

// 3. Let go.
await A.keyboard.up('k');
await A.waitForTimeout(1500);
{
  const v = await ptt(A);
  const keyup = v.keyups.filter((k) => k.code === 'KeyK').pop();
  const call = v.setMic.filter((m) => !m.on && m.t > keyup.t)[0];
  const off = v.micTrack.filter((m) => !m.on && m.t > keyup.t)[0];
  const tail = call ? call.t - keyup.t : -1;
  check(
    tail >= 195 && tail < keyup.timer + 50,
    `A: setMicTrack(null) ${Math.round(tail)} ms after the keyup; a plain 200 ms timer took ${Math.round(keyup.timer)} ms (sender track null seen at ${off ? Math.round(off.t - keyup.t) : '?'} ms)`
  );
}
a0 = await rtp(A);
await A.waitForTimeout(2000);
a1 = await rtp(A);
check(a1.out - a0.out === 0, `A: no RTP after letting go (${a1.out - a0.out} in 2 s)`);

// 4. K in the chat input types "k".
await A.keyboard.press('y');
await A.waitForTimeout(300);
a0 = await rtp(A);
await A.keyboard.down('k');
await A.waitForTimeout(1000);
await A.keyboard.up('k');
const typed = await A.inputValue('#hud-chat-input-field');
a1 = await rtp(A);
check(typed === 'k', `A: K in the chat input typed ${JSON.stringify(typed)}`);
check(a1.out - a0.out === 0, `A: nothing sent while typing K (${a1.out - a0.out})`);
await A.keyboard.press('Escape');
await A.waitForTimeout(300);

// 5. B: voice volume 0.
await B.keyboard.press('F3');
await B.waitForTimeout(500);
await setRange(B, 'setting-voiceVolume', 0);
await B.keyboard.press('F3');
await A.keyboard.down('k');
await A.waitForTimeout(500);
const level0 = await playedLevel(B, 2000);
await A.keyboard.up('k');
check(level0 < 0.0005, `B: at voice volume 0 the peak RMS is ${level0.toFixed(5)}`);
await B.keyboard.press('F3');
await B.waitForTimeout(300);
await setRange(B, 'setting-voiceVolume', 80);
await B.keyboard.press('F3');

// 6. B: permission denied.
await B.waitForTimeout(500);
await B.keyboard.down('k');
await B.waitForTimeout(1500);
const notice = await B.evaluate(() => ({
  hidden: document.getElementById('hud-voice-notice').hidden,
  text: document.getElementById('hud-voice-notice').textContent.replace(/\s+/g, ' ').trim(),
}));
await shot(B, 'a4-denied');
await B.keyboard.up('k');
check(!notice.hidden && /Microphone blocked/.test(notice.text), `B: notice ${JSON.stringify(notice)}`);
check((await ptt(B)).gum === 1, `B: getUserMedia asked once (${(await ptt(B)).gum})`);
await B.keyboard.press('F3');
await B.waitForTimeout(500);
const help = await B.textContent('.settings-voice-status');
check(/blocked/i.test(help), `B: settings help: ${JSON.stringify(help)}`);
await shot(B, 'a4-denied-settings');
await B.keyboard.press('F3');

// 7. A: voice off.
await A.keyboard.press('F3');
await A.waitForTimeout(500);
await A.click('label:has(#setting-voiceEnabled)');
await A.keyboard.press('F3');
await A.waitForTimeout(300);
const gumBefore = (await ptt(A)).gum;
a0 = await rtp(A);
await A.keyboard.down('k');
await A.waitForTimeout(1500);
await A.keyboard.up('k');
a1 = await rtp(A);
const masterOff = await A.evaluate(() => window.__ptt.master?.gain.value);
check((await ptt(A)).gum === gumBefore, `A: voice off, K asks for nothing (${gumBefore} -> ${(await ptt(A)).gum})`);
check(a1.out - a0.out === 0, `A: voice off, nothing sent (${a1.out - a0.out})`);
check(masterOff === 0, `A: voice off, master gain ${masterOff}`);
await A.keyboard.press('F3');
await A.waitForTimeout(300);
await A.click('label:has(#setting-voiceEnabled)');
await A.keyboard.press('F3');

// 8. Settings on the login page.
{
  // B's browser has no fake UI (A's grants the microphone to every page),
  // so before the permission the microphones have no names and only the
  // default is listed; the permission is then granted as a click on
  // "Allow" would.
  const ctx = await browserB.newContext();
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.click('#settings-launcher-button');
  await page.waitForTimeout(300);
  const before = await page.$$eval('#setting-voiceInput option', (o) => o.map((x) => x.textContent));
  await ctx.grantPermissions(['microphone'], { origin });
  await page.click('.settings-voice-test button');
  let meter = 0;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(100);
    meter = Math.max(meter, Number(await page.getAttribute('.settings-voice-meter', 'aria-valuenow')));
  }
  const after = await page.$$eval('#setting-voiceInput option', (o) => o.map((x) => [x.value.slice(0, 8), x.textContent]));
  await shot(page, 'a4-settings-test');
  check(meter > 0, `login page: test meter peak ${meter}%`);
  check(before.length === 1 && after.length > 1, `microphones before ${JSON.stringify(before)}, after permission ${JSON.stringify(after)}`);
  await page.click('.settings-voice-test button');
  await setRange(page, 'setting-voiceVolume', 55);
  await page.selectOption('#setting-voiceKey', 'j');
  const device = await page.$$eval('#setting-voiceInput option', (o) => o[o.length - 1].value);
  await page.selectOption('#setting-voiceInput', device);
  await page.reload();
  await page.click('#settings-launcher-button');
  await page.waitForTimeout(300);
  const kept = await page.evaluate(() => ({
    volume: document.getElementById('setting-voiceVolume').value,
    key: document.getElementById('setting-voiceKey').value,
    input: document.getElementById('setting-voiceInput').value,
    stored: JSON.parse(localStorage.getItem('player-settings')),
  }));
  check(
    kept.volume === '55' && kept.key === 'j' && kept.input === device,
    `after reload: volume ${kept.volume}, key ${kept.key}, mic ${kept.input === device ? 'kept' : kept.input}`
  );
  await ctx.close();
}

// 9. Touch.
await browserA.close();
const browserC = await launch();
const C = await join(browserC, 'PttC', { touch: true, width: 844, height: 390 });
await C.context().grantPermissions(['microphone'], { origin });
await C.waitForTimeout(2000);
const box = await C.evaluate(() => {
  const b = document.getElementById('voice-button');
  const r = b.getBoundingClientRect();
  return { hidden: b.hidden, x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width };
});
await shot(C, 'a4-touch');
check(!box.hidden && box.w > 0, `C: microphone button shown at ${Math.round(box.x)},${Math.round(box.y)}`);
check((await ptt(C)).gum === 0, `C: no getUserMedia before the button (${(await ptt(C)).gum})`);
{
  await C.evaluate(() => {
    window.__ptt.pointers = [];
    for (const type of ['pointerdown', 'pointerup', 'pointercancel']) {
      document.getElementById('voice-button').addEventListener(type, (e) =>
        window.__ptt.pointers.push(`${type} ${e.pointerType} ${e.pointerId}`)
      );
    }
  });
  const cdp = await C.context().newCDPSession(C);
  const point = [{ x: box.x, y: box.y, id: 1 }];
  b0 = await rtp(B);
  let c0 = await rtp(C);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point });
  await C.waitForTimeout(800);
  const pressed = await C.getAttribute('#voice-button', 'aria-pressed');
  await shot(C, 'a4-touch-talking');
  await C.waitForTimeout(2700);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  let c1 = await rtp(C);
  b1 = await rtp(B);
  console.log('  C pointer events:', JSON.stringify((await ptt(C)).pointers));
  check(pressed === 'true', `C: button pressed while held (${pressed})`);
  check(c1.out - c0.out > 100, `C: sent ${c1.out - c0.out} RTP packets while holding the button`);
  check(b1.in - b0.in > 100, `B: got ${b1.in - b0.in} lane packets from C`);
  await C.waitForTimeout(1000);
  c0 = await rtp(C);
  await C.waitForTimeout(2000);
  c1 = await rtp(C);
  check(c1.out - c0.out === 0, `C: nothing sent after letting go (${c1.out - c0.out})`);
}

await browserB.close();
await browserC.close();
console.log(failures ? `${failures} FAILED` : 'all OK');
process.exit(failures ? 1 : 0);
