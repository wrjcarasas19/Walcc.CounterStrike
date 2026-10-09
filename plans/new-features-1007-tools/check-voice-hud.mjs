// A.5: speaking indicators and mutes, through the real page.
//
// usage: pw.sh check-voice-hud.mjs
//   Start the server without bots (`run-server.sh de_dust2 0`). Joins
//   "HudA" and "HudB" (desktop 1280x800, fake microphone), both CT, one
//   browser each, then:
//   1. A holds K (CYCLES times, 3 s each): when B's speaking list
//      (#hud-voice) shows HudA compared with B's lane event (page time), and
//      when the entry goes compared with A's setMicTrack(null) (the end of
//      the 200 ms tail; both pages' clocks are epoch-based) and with the
//      server's quiet event; A's own entry (mic icon) follows the key.
//      Desktop screenshot with chat lines.
//   2. B holds Tab: the scoreboard row of HudA has the speaking icon; a
//      right click frees the pointer (if the game had it locked) and makes
//      the mute buttons clickable; clicking HudA's mutes (aria-pressed,
//      localStorage `voice-mutes`); after Tab, a click locks the pointer
//      again.
//   3. Muted: A talks, B plays it at 0 (level after the master gain, and
//      the lane's gain node), HudA isn't listed; the scoreboard shows the
//      crossed-out speaker.
//   4. B reloads and joins again: the mute is still there and applies;
//      clicking again unmutes and A is heard.
//   5. Admin mute display hook (A.6 sends it): a {"muted":[userid]} voice
//      event fed to the pages' handler shows the crossed-out microphone on
//      both scoreboards and in A's own speaking entry.
//   6. "HudC" on a touch phone viewport (844x390): A talks, C's list shows
//      HudA above the chat (screenshot); scoreboard (+showscores) with the
//      mute buttons tappable (CDP touch); tap mutes.
// Screenshots `a5-*.png` in `out/`. Prints OK / FAIL per check.
import { chromium } from '../new-features-1006-tools/node_modules/playwright/index.mjs';
import {
  newPage,
  joinGame,
  waitForPlayer,
  engineCommand,
  shot,
  BASE,
} from '../new-features-1006-tools/lib.mjs';

const CYCLES = Number(process.env.CYCLES ?? 5);

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
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  });

let failures = 0;
function check(ok, text) {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${text}`);
}

// Runs in the page before its scripts. Times are epoch ms
// (performance.timeOrigin + now), comparable between the pages.
function instrument() {
  const now = () => performance.timeOrigin + performance.now();
  const v = (window.__hud = {
    lanes: [],
    list: [],
    keys: [],
    setMic: [],
    gains: [],
    master: undefined,
  });
  window.addEventListener(
    'keydown',
    (e) => !e.repeat && v.keys.push({ t: now(), type: 'down', code: e.code }),
    { capture: true }
  );
  window.addEventListener('keyup', (e) => v.keys.push({ t: now(), type: 'up', code: e.code }), {
    capture: true,
  });
  v.ssrc = [];
  const sources = RTCRtpReceiver.prototype.getSynchronizationSources;
  RTCRtpReceiver.prototype.getSynchronizationSources = function () {
    const result = sources.call(this);
    // [when, the newest packet's playout time] (epoch ms in Chrome).
    if (result.length) v.ssrc.push([now(), Math.max(...result.map((r) => r.timestamp))]);
    if (v.ssrc.length > 400) v.ssrc.shift();
    return result;
  };
  document.addEventListener('DOMContentLoaded', () => {
    const list = document.getElementById('hud-voice');
    if (!list) return;
    new MutationObserver(() => {
      const entry = {
        t: now(),
        names: [...list.children].map((c) => c.textContent),
        icons: [...list.children].map((c) => c.className),
        frame: 0,
      };
      v.list.push(entry);
      requestAnimationFrame(() => (entry.frame = now()));
    }).observe(list, { childList: true });
  });
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (target, ...rest) {
    if (this instanceof GainNode && target === this.context.destination && !v.master) {
      v.masterCandidate = this;
    }
    return connect.call(this, target, ...rest);
  };
  const source = AudioContext.prototype.createMediaStreamSource;
  AudioContext.prototype.createMediaStreamSource = function (stream) {
    if (v.masterCandidate?.context === this) v.master = v.masterCandidate;
    return source.call(this, stream);
  };
  const createGain = AudioContext.prototype.createGain;
  AudioContext.prototype.createGain = function () {
    const gain = createGain.call(this);
    v.gains.push(gain);
    return gain;
  };
  const timer = setInterval(() => {
    const e = window.__engine;
    if (!e?.onVoiceLane) return;
    clearInterval(timer);
    const lane = e.onVoiceLane;
    e.onVoiceLane = (l, u) => {
      v.lanes.push({ t: now(), lane: l, userid: u });
      lane(l, u);
    };
    const setMic = e.setMicTrack.bind(e);
    e.setMicTrack = (track) => {
      v.setMic.push({ t: now(), on: !!track });
      return setMic(track);
    };
  }, 5);
}

const hudOf = (page) => page.evaluate(() => window.__hud);

// Level after the master gain (voice volume), 0..1 RMS, over ms.
async function playedLevel(page, ms) {
  return page.evaluate(async (ms) => {
    const master = window.__hud.master;
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

// The per-lane gains (every gain the page made but the master and the
// microphone test's).
const laneGains = (page) =>
  page.evaluate(() =>
    window.__hud.gains.filter((g) => g !== window.__hud.master).map((g) => g.gain.value)
  );

async function join(browser, name, opts = {}) {
  const page = await newPage(browser, { tag: name, ...opts });
  await page.context().addInitScript(instrument);
  await page.context().grantPermissions(['microphone'], { origin: new URL(BASE).origin });
  await joinGame(page, { name });
  await waitForPlayer(name);
  await engineCommand(page, 'jointeam 2');
  await page.waitForTimeout(1000);
  await engineCommand(page, 'joinclass 1');
  await page.waitForTimeout(3000);
  // Fewer engine frames leave the page's timers less starved (SwiftShader).
  if (process.env.FPS) await engineCommand(page, `fps_max ${process.env.FPS}`);
  return page;
}

const rowOf = (page, name) =>
  page.evaluate((name) => {
    for (const row of document.querySelectorAll('#hud-scoreboard .sb-row:not(.sb-labels)')) {
      if (row.querySelector('.sb-name')?.textContent !== name) continue;
      const button = row.querySelector('.sb-mute');
      const box = button?.getBoundingClientRect();
      return {
        speaking: !!row.querySelector('.sb-voice-icon.speaking'),
        adminMuted: !!row.querySelector('.sb-voice-icon.admin-muted'),
        button: button
          ? {
              pressed: button.getAttribute('aria-pressed'),
              visible: getComputedStyle(button).display !== 'none',
              pointer: getComputedStyle(button).pointerEvents,
              x: box.x + box.width / 2,
              y: box.y + box.height / 2,
            }
          : null,
      };
    }
    return null;
  }, name);

const listNames = (page) =>
  page.$$eval('#hud-voice .hud-voice-entry', (els) =>
    els.map((el) => ({ name: el.textContent, cls: el.className }))
  );

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

// --- A and B ---
const browserA = await launch();
const A = await join(browserA, 'HudA');
const browserB = await launch();
let B = await join(browserB, 'HudB');
await A.mouse.click(640, 400);
await B.mouse.click(640, 400);
await engineCommand(A, 'say hello from A');
await A.waitForTimeout(500);
await engineCommand(B, 'say and hi from B');

// Warm-up press (the first one asks for the microphone).
await A.keyboard.down('k');
await A.waitForTimeout(1500);
await A.keyboard.up('k');
await A.waitForTimeout(1500);

// 1. Timing.
const appear = [];
const clear = [];
const clearVsQuiet = [];
const frames = [];
const localAppear = [];
const localClear = [];
const afterAudio = [];
const pollGaps = [];
let uidA = 0;
for (let i = 0; i < CYCLES; i++) {
  const since = Date.now() - 100;
  await A.keyboard.down('k');
  await A.waitForTimeout(i === 0 ? 1000 : 3000);
  if (i === 0) {
    await shot(B, 'a5-desktop-speaking');
    await shot(A, 'a5-desktop-self');
    await A.waitForTimeout(2000);
  }
  await A.keyboard.up('k');
  await A.waitForTimeout(1500);
  const a = await hudOf(A);
  const b = await hudOf(B);
  const laneOn = b.lanes.find((e) => e.t > since && e.userid > 0);
  const laneOff = b.lanes.find((e) => laneOn && e.t > laneOn.t && e.userid === 0);
  if (laneOn) uidA = laneOn.userid;
  const shown = b.list.find((e) => laneOn && e.t >= laneOn.t - 1 && e.names.includes('HudA'));
  const gone = b.list.find((e) => shown && e.t > shown.t && !e.names.includes('HudA'));
  const stop = a.setMic.filter((m) => !m.on && m.t > since).pop();
  const keyDown = a.keys.filter((k) => k.code === 'KeyK' && k.type === 'down' && k.t > since)[0];
  const keyUp = a.keys.filter((k) => k.code === 'KeyK' && k.type === 'up' && k.t > since)[0];
  const selfOn = a.list.find((e) => e.t > since && e.icons.some((c) => /local/.test(c)));
  const selfOff = a.list.find((e) => selfOn && e.t > selfOn.t && !e.icons.some((c) => /local/.test(c)));
  // The last packet B played from A: what the page's own poll saw last
  // before the entry went.
  const lastAudio = gone && b.ssrc.filter((x) => x[0] <= gone.t + 1).pop()?.[1];
  const polls = gone ? b.ssrc.filter((x) => x[0] > gone.t - 1500 && x[0] <= gone.t + 1) : [];
  const gaps = polls.slice(1).map((x, j) => x[0] - polls[j][0]);
  if (lastAudio) afterAudio.push(gone.t - lastAudio);
  if (gaps.length) pollGaps.push(median(gaps));
  if (laneOn && shown) appear.push(shown.t - laneOn.t);
  if (shown?.frame) frames.push(shown.frame - shown.t);
  if (stop && gone) clear.push(gone.t - stop.t);
  if (laneOff && gone) clearVsQuiet.push(laneOff.t - gone.t);
  if (keyDown && selfOn) localAppear.push(selfOn.t - keyDown.t);
  if (stop && selfOff) localClear.push(selfOff.t - stop.t);
  console.log(
    `  cycle ${i + 1}: key->B lane event ${laneOn && keyDown ? Math.round(laneOn.t - keyDown.t) : '?'} ms; ` +
      `lane event->B list ${laneOn && shown ? (shown.t - laneOn.t).toFixed(1) : '?'} ms (next frame +${shown?.frame ? Math.round(shown.frame - shown.t) : '?'}); ` +
      `keyup->sending stopped ${stop && keyUp ? Math.round(stop.t - keyUp.t) : '?'} ms; ` +
      `sending stopped->B entry gone ${stop && gone ? Math.round(gone.t - stop.t) : '?'} ms ` +
      `(${afterAudio.length && gone ? Math.round(afterAudio[afterAudio.length - 1]) : '?'} ms after the last packet B played; B's 20 ms poll ran every ${pollGaps.length ? Math.round(pollGaps[pollGaps.length - 1]) : '?'} ms); ` +
      `server quiet event ${laneOff && stop ? Math.round(laneOff.t - stop.t) : '?'} ms after; ` +
      `A own entry +${keyDown && selfOn ? Math.round(selfOn.t - keyDown.t) : '?'} ms / gone ${stop && selfOff ? Math.round(selfOff.t - stop.t) : '?'} ms after sending stopped`
  );
}
check(appear.length === CYCLES && Math.max(...appear) < 100, `B: HudA listed ${appear.map((x) => x.toFixed(1)).join(', ')} ms after the lane event (next frame after that: median ${median(frames)} ms)`);
check(
  afterAudio.length === CYCLES && median(afterAudio) < 100 + median(pollGaps),
  `B: HudA's entry gone ${afterAudio.map(Math.round).join(', ')} ms after the last packet B played (polls every ${pollGaps.map(Math.round).join(', ')} ms), ` +
    `${clear.map(Math.round).join(', ')} ms after A stopped sending; the server's quiet event came ${clearVsQuiet.map(Math.round).join(', ')} ms later still`
);
check(localAppear.length === CYCLES && Math.max(...localAppear) < 100, `A: own entry (mic icon) ${localAppear.map(Math.round).join(', ')} ms after the keydown; gone ${localClear.map(Math.round).join(', ')} ms after sending stopped`);
console.log(`  B list entries seen: ${JSON.stringify((await hudOf(B)).list.slice(-2))}`);

if (process.env.STOP_AFTER === '1') process.exit(failures ? 1 : 0);

// 2. Scoreboard.
await B.keyboard.down('Tab');
await A.keyboard.down('k');
await B.waitForTimeout(1200);
let row = await rowOf(B, 'HudA');
const locked = await B.evaluate(() => !!document.pointerLockElement);
await shot(B, 'a5-scoreboard-speaking');
await A.keyboard.up('k');
check(row?.speaking, `B: scoreboard row HudA speaking icon (${JSON.stringify(row)})`);
check(row?.button && (locked ? !row.button.visible : row.button.visible), `B: mute button ${locked ? 'hidden while the pointer is locked' : 'shown (pointer not locked)'}; hint shown ${await B.evaluate(() => !document.getElementById('sb-voice-hint').hidden)}`);
await B.mouse.move(640, 400);
await B.mouse.down({ button: 'right' });
await B.mouse.up({ button: 'right' });
await B.waitForTimeout(300);
row = await rowOf(B, 'HudA');
const free = await B.evaluate(() => ({
  locked: !!document.pointerLockElement,
  cls: document.getElementById('hud').classList.contains('sb-pointer'),
  hint: !document.getElementById('sb-voice-hint').hidden,
}));
check(!free.locked && free.cls && row?.button?.visible && row.button.pointer === 'auto', `B: after a right click (locked before: ${locked}): ${JSON.stringify(free)}, button ${JSON.stringify(row?.button)}`);
await shot(B, 'a5-scoreboard-pointer');
await B.mouse.click(row.button.x, row.button.y);
await B.waitForTimeout(300);
row = await rowOf(B, 'HudA');
const stored = await B.evaluate(() => localStorage.getItem('voice-mutes'));
check(row?.button?.pressed === 'true' && stored === '["HudA"]', `B: clicked mute: aria-pressed ${row?.button?.pressed}, voice-mutes ${stored}`);
await shot(B, 'a5-scoreboard-muted');
await B.keyboard.up('Tab');
await B.waitForTimeout(300);
const muteBox = await B.evaluate(() => {
  const el = document.querySelector('#hud-scoreboard');
  return el.hidden;
});
check(muteBox, 'B: scoreboard closed after Tab up');
// The game takes the pointer back on the next click, as after any unlock.
await B.mouse.click(640, 400);
await B.waitForTimeout(500);
const relocked = await B.evaluate(() => document.pointerLockElement?.id ?? null);
check(relocked === 'canvas', `B: a click on the game locks the pointer again (${relocked})`);

// 3. Muted.
async function talkAndMeasure(listener) {
  await A.keyboard.down('k');
  await A.waitForTimeout(600);
  const levelP = playedLevel(listener, 2000);
  await A.waitForTimeout(800);
  const listed = await listNames(listener);
  const gains = await laneGains(listener);
  const level = await levelP;
  await A.keyboard.up('k');
  await A.waitForTimeout(1200);
  return { level, listed, gains };
}
{
  const r = await talkAndMeasure(B);
  check(r.level < 0.0005 && r.gains.includes(0) && !r.listed.some((e) => e.name === 'HudA'), `B, HudA muted: peak RMS ${r.level.toFixed(5)}, lane gains ${JSON.stringify(r.gains)}, list ${JSON.stringify(r.listed)}`);
}

// 4. Reload B (the same browser context, so the same localStorage).
await B.goto('about:blank');
await B.waitForTimeout(5000);
await joinGame(B, { name: 'HudB' });
await waitForPlayer('HudB');
await engineCommand(B, 'jointeam 2');
await B.waitForTimeout(1000);
await engineCommand(B, 'joinclass 1');
await B.waitForTimeout(3000);
if (process.env.FPS) await engineCommand(B, `fps_max ${process.env.FPS}`);
await B.mouse.click(640, 400);
await B.waitForTimeout(2000);
{
  const r = await talkAndMeasure(B);
  check(r.level < 0.0005 && r.gains.includes(0), `B after reload: HudA still muted: peak RMS ${r.level.toFixed(5)}, lane gains ${JSON.stringify(r.gains)}`);
  await B.keyboard.down('Tab');
  await B.waitForTimeout(800);
  row = await rowOf(B, 'HudA');
  check(row?.button?.pressed === 'true' && row.button.visible, `B after reload: scoreboard shows HudA muted (${JSON.stringify(row?.button)})`);
  if (!(await B.evaluate(() => document.getElementById('hud').classList.contains('sb-pointer')))) {
    await B.mouse.down({ button: 'right' });
    await B.mouse.up({ button: 'right' });
    await B.waitForTimeout(300);
    row = await rowOf(B, 'HudA');
  }
  await B.mouse.click(row.button.x, row.button.y);
  await B.waitForTimeout(300);
  await B.keyboard.up('Tab');
  const r2 = await talkAndMeasure(B);
  const stored2 = await B.evaluate(() => localStorage.getItem('voice-mutes'));
  check(r2.level > 0.0005 && r2.listed.some((e) => e.name === 'HudA'), `B unmuted HudA: peak RMS ${r2.level.toFixed(4)}, list ${JSON.stringify(r2.listed)}, voice-mutes ${stored2}`);
}

// 5. The admin-mute display hook.
await A.evaluate((uid) => window.__engine.voiceLane({ muted: [uid] }), uidA);
await B.evaluate((uid) => window.__engine.voiceLane({ muted: [uid] }), uidA);
await B.keyboard.down('Tab');
await A.keyboard.down('Tab');
await A.waitForTimeout(800);
const rowB = await rowOf(B, 'HudA');
const rowA = await rowOf(A, 'HudA');
await shot(B, 'a5-admin-muted-scoreboard');
await A.keyboard.up('Tab');
await B.keyboard.up('Tab');
await A.keyboard.down('k');
await A.waitForTimeout(500);
const selfMuted = await listNames(A);
await shot(A, 'a5-admin-muted-self');
await A.keyboard.up('k');
check(rowB?.adminMuted && rowA?.adminMuted, `admin-muted HudA (userid ${uidA}): crossed-out mic on B's scoreboard ${rowB?.adminMuted}, on A's own row ${rowA?.adminMuted}`);
check(selfMuted.some((e) => /admin-muted/.test(e.cls)), `A, admin-muted, holding K: own entry ${JSON.stringify(selfMuted)}`);
await A.evaluate(() => window.__engine.voiceLane({ muted: [] }));
await B.evaluate(() => window.__engine.voiceLane({ muted: [] }));
await A.waitForTimeout(300);

// 6. Phone viewport.
await browserB.close();
const browserC = await launch();
const C = await join(browserC, 'HudC', { touch: true, width: 844, height: 390 });
await C.waitForTimeout(2000);
await engineCommand(A, 'say a line for the phone');
await A.waitForTimeout(500);
await A.keyboard.down('k');
await A.waitForTimeout(1500);
const phoneList = await C.evaluate(() => {
  const list = document.getElementById('hud-voice').getBoundingClientRect();
  const chat = document.getElementById('hud-chat').getBoundingClientRect();
  return { listBottom: Math.round(list.bottom), listLeft: Math.round(list.left), chatTop: Math.round(chat.top), names: document.getElementById('hud-voice').textContent };
});
await shot(C, 'a5-phone-speaking');
await A.keyboard.up('k');
check(/HudA/.test(phoneList.names) && phoneList.listBottom <= phoneList.chatTop, `C (phone): list ${JSON.stringify(phoneList)}`);
await engineCommand(C, '+showscores');
await C.waitForTimeout(1000);
row = await rowOf(C, 'HudA');
await shot(C, 'a5-phone-scoreboard');
check(row?.button?.visible && row.button.pointer === 'auto', `C (phone): scoreboard mute button tappable (${JSON.stringify(row?.button)})`);
if (row?.button) {
  const cdp = await C.context().newCDPSession(C);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: row.button.x, y: row.button.y, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await C.waitForTimeout(300);
  row = await rowOf(C, 'HudA');
  await shot(C, 'a5-phone-muted');
  check(row?.button?.pressed === 'true', `C (phone): tapped mute: aria-pressed ${row?.button?.pressed}`);
}
await engineCommand(C, '-showscores');

await browserA.close();
await browserC.close();
console.log(failures ? `${failures} FAILED` : 'all OK');
process.exit(failures ? 1 : 0);
