// A.6: server and admin controls, through the real page and the admin API.
//
// usage: pw.sh check-voice-admin.mjs [novoice]
//   Start the server without bots (`run-server.sh de_dust2 0`). "AdmA"
//   (talker) and "AdmB" (listener and admin) join as CTs, fake microphone,
//   one browser each; then:
//   1. A holds K: B receives A's RTP (baseline).
//   2. B opens F4 → Players and clicks "Mute" on AdmA's row: the
//      button turns into "Unmute"; A holds K: B receives nothing and
//      gets no lane event; both scoreboards show the crossed-out microphone
//      on AdmA's row, and A's own speaking entry is crossed out.
//   3. B clicks "Unmute": A is heard again, the crossed-out mic goes.
//   4. sv_voiceenable 0 through the admin API (the Match tab's action):
//      neither hears the other; 1: heard again.
//   5. B turns Voice chat off in the settings (the page tells the server):
//      B receives no RTP while A talks; on again: heard.
//   6. The login page shows the Voice settings group (status.json has no
//      voiceOff).
// `novoice`, against `VOICE=0 run-server.sh de_dust2 0`: status.json says
// voiceOff; the login page's settings have no Voice group and no talk key;
// in game no mic button, no Voice settings, no scoreboard voice cells or
// hint, holding K asks for no microphone, and the F4 Players tab has no
// Mute button. Prints OK / FAIL.
import { chromium } from '../new-features-1006-tools/node_modules/playwright/index.mjs';
import {
  newPage,
  joinGame,
  waitForPlayer,
  engineCommand,
  openAdmin,
  adminAction,
  shot,
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
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  });

let failures = 0;
function check(ok, text) {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${text}`);
}

// Counts getUserMedia calls, lane events and the voice channel's messages
// both ways.
function instrument() {
  const v = (window.__adm = { gum: 0, lanes: [], voiceIn: [], voiceOut: [] });
  const md = navigator.mediaDevices;
  if (md) {
    const gum = md.getUserMedia.bind(md);
    md.getUserMedia = (c) => {
      v.gum++;
      return gum(c);
    };
  }
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (data) {
    if (this.label === 'voice') v.voiceOut.push(String(data));
    return send.call(this, data);
  };
  const timer = setInterval(() => {
    const e = window.__engine;
    if (!e?.onVoiceLane) return;
    clearInterval(timer);
    const lane = e.onVoiceLane;
    e.onVoiceLane = (l, u) => {
      v.lanes.push({ t: Date.now(), lane: l, userid: u });
      lane(l, u);
    };
    const muted = e.onVoiceMuted;
    e.onVoiceMuted = (list) => {
      v.voiceIn.push({ t: Date.now(), muted: list });
      muted?.(list);
    };
  }, 5);
}

// RTP packets received on the lanes so far.
const rtpIn = (page) =>
  page.evaluate(async () => {
    const e = window.__engine;
    let n = 0;
    if (e.peer) {
      (await e.peer.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && (e.laneMids ?? []).includes(r.mid)) {
          n += r.packetsReceived ?? 0;
        }
      });
    }
    return n;
  });
const adm = (page) => page.evaluate(() => window.__adm);

async function join(browser, name) {
  const page = await newPage(browser, { tag: name });
  await page.context().addInitScript(instrument);
  await page.context().grantPermissions(['microphone'], { origin: new URL(BASE).origin });
  await joinGame(page, { name });
  await waitForPlayer(name);
  await engineCommand(page, 'jointeam 2');
  await page.waitForTimeout(1000);
  await engineCommand(page, 'joinclass 1');
  await page.waitForTimeout(3000);
  await page.mouse.click(640, 400);
  return page;
}

// A holds K for ms; returns the packets listener received meanwhile and
// the lane events it got.
async function talk(talker, listener, ms = 3000) {
  const before = await rtpIn(listener);
  const lanes = (await adm(listener)).lanes.length;
  await talker.keyboard.down('k');
  await talker.waitForTimeout(ms);
  await talker.keyboard.up('k');
  await talker.waitForTimeout(800);
  return {
    packets: (await rtpIn(listener)) - before,
    lanes: (await adm(listener)).lanes.slice(lanes),
  };
}

const scoreRow = (page, name) =>
  page.evaluate((name) => {
    for (const row of document.querySelectorAll('#hud-scoreboard .sb-row:not(.sb-labels)')) {
      if (row.querySelector('.sb-name')?.textContent !== name) continue;
      const cell = row.querySelector('.sb-voice');
      return {
        adminMuted: !!row.querySelector('.sb-voice-icon.admin-muted'),
        cell: cell ? cell.childElementCount : -1,
      };
    }
    return null;
  }, name);

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

// The voice Mute button of name's row in the open Players tab.
const voiceButton = (page, name) =>
  page.evaluate((name) => {
    for (const row of document.querySelectorAll('.admin-players .admin-player')) {
      if (row.querySelector('.admin-player-name')?.textContent !== name) continue;
      const b = row.querySelector('.admin-player-voice');
      if (!b) return null;
      return {
        text: b.textContent,
        hidden: b.hidden || getComputedStyle(b).display === 'none',
        disabled: b.disabled,
        pressed: b.getAttribute('aria-pressed'),
      };
    }
    return null;
  }, name);

async function openPlayers(page) {
  await openAdmin(page);
  await page.click('#admin-tab-players');
  await page.waitForTimeout(1500);
}

async function closeAdmin(page) {
  await page.keyboard.press('F4');
  await page.waitForTimeout(500);
  await page.mouse.click(640, 400);
}

async function clickVoiceButton(page, name, want) {
  await page.evaluate((name) => {
    for (const row of document.querySelectorAll('.admin-players .admin-player')) {
      if (row.querySelector('.admin-player-name')?.textContent === name) {
        row.querySelector('.admin-player-voice')?.click();
      }
    }
  }, name);
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(250);
    if ((await voiceButton(page, name))?.text === want) break;
  }
  return voiceButton(page, name);
}

// The login page's settings: Voice group and talk key shown?
async function loginSettings(browser) {
  const page = await newPage(browser, { tag: 'login' });
  await page.goto(BASE);
  // The lobby's first /status.json.
  await page.waitForTimeout(2500);
  await page.click('#settings-launcher-button');
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => ({
    voiceGroup: !document.getElementById('setting-voiceEnabled')?.closest('section')?.hidden,
    voiceKey: !document.getElementById('setting-voiceKey')?.closest('.field')?.hidden,
    visibleGroup: document.getElementById('setting-voiceEnabled')?.offsetParent !== null,
  }));
  await page.context().close();
  return r;
}

const status = async () => (await fetch(`${BASE}/status.json`)).json();

if (process.argv[2] === 'novoice') {
  const st = await status();
  check(st.voiceOff === true, `status.json voiceOff: ${st.voiceOff}`);
  const browser = await launch();
  const login = await loginSettings(browser);
  check(!login.voiceGroup && !login.visibleGroup && !login.voiceKey, `login page: Voice group hidden, talk key hidden (${JSON.stringify(login)})`);
  const A = await join(browser, 'AdmA');
  await A.keyboard.down('k');
  await A.waitForTimeout(2000);
  await A.keyboard.up('k');
  const ui = await A.evaluate(() => ({
    available: window.__engine.voiceAvailable,
    gum: window.__adm.gum,
    micButton: !document.getElementById('voice-button')?.hidden,
    voiceGroup: !document.getElementById('setting-voiceEnabled')?.closest('section')?.hidden,
    voiceKey: !document.getElementById('setting-voiceKey')?.closest('.field')?.hidden,
    list: document.querySelectorAll('#hud-voice > *').length,
  }));
  check(!ui.available && ui.gum === 0 && !ui.micButton && !ui.voiceGroup && !ui.voiceKey && ui.list === 0, `in game without voice: ${JSON.stringify(ui)}`);
  const row = await withScoreboard(A, () => scoreRow(A, 'AdmA'));
  const hint = await A.evaluate(() => {
    const h = document.getElementById('sb-voice-hint');
    return h ? !h.hidden : false;
  });
  check(row && row.cell <= 0 && !hint, `scoreboard without voice cells or hint (${JSON.stringify(row)}, hint ${hint})`);
  await openPlayers(A);
  const button = await voiceButton(A, 'AdmA');
  check(!button || button.hidden, `Players tab: no voice Mute button (${JSON.stringify(button)})`);
  await shot(A, 'a6-novoice-players');
  await browser.close();
  process.exit(failures ? 1 : 0);
}

{
  const st = await status();
  check(!st.voiceOff, `status.json voiceOff: ${st.voiceOff}`);
  const browser = await launch();
  const login = await loginSettings(browser);
  check(login.voiceGroup && login.visibleGroup && login.voiceKey, `login page: Voice group and talk key shown (${JSON.stringify(login)})`);
  await browser.close();
}

const browserA = await launch();
const A = await join(browserA, 'AdmA');
const browserB = await launch();
const B = await join(browserB, 'AdmB');

// Warm-up press (the first one asks for the microphone).
await talk(A, B, 1500);

// 1. Baseline.
let r = await talk(A, B);
const uidA = r.lanes.find((e) => e.userid > 0)?.userid ?? 0;
check(r.packets > 50 && uidA > 0, `baseline: B got ${r.packets} packets from A (userid ${uidA})`);

// 2. Admin mute from B's Players tab.
await openPlayers(B);
let button = await voiceButton(B, 'AdmA');
check(button && !button.hidden && button.text === 'Mute', `Players tab: AdmA's button ${JSON.stringify(button)}`);
const ownButton = await voiceButton(B, 'AdmB');
check(ownButton && ownButton.disabled, `Players tab: own row's button disabled (${JSON.stringify(ownButton)})`);
button = await clickVoiceButton(B, 'AdmA', 'Unmute');
check(button?.text === 'Unmute' && button.pressed === 'true', `clicked: ${JSON.stringify(button)}`);
await shot(B, 'a6-players-muted');
const statusLine = await B.evaluate(() => document.querySelector('.admin-status, #admin-status')?.textContent ?? '');
console.log(`  status line: ${statusLine}`);
await closeAdmin(B);
await B.waitForTimeout(500);
r = await talk(A, B);
check(r.packets === 0 && !r.lanes.some((e) => e.userid > 0), `muted: B got ${r.packets} packets, lane events ${JSON.stringify(r.lanes)}`);
const mutedIn = { A: (await adm(A)).voiceIn.at(-1), B: (await adm(B)).voiceIn.at(-1) };
check(
  JSON.stringify(mutedIn.A?.muted) === JSON.stringify([uidA]) && JSON.stringify(mutedIn.B?.muted) === JSON.stringify([uidA]),
  `muted list on both pages: A ${JSON.stringify(mutedIn.A)}, B ${JSON.stringify(mutedIn.B)}`
);
const rowB = await withScoreboard(B, async () => {
  await shot(B, 'a6-scoreboard-admin-muted');
  return scoreRow(B, 'AdmA');
});
const rowA = await withScoreboard(A, () => scoreRow(A, 'AdmA'));
check(rowB?.adminMuted && rowA?.adminMuted, `crossed-out mic on AdmA's row: B ${JSON.stringify(rowB)}, A ${JSON.stringify(rowA)}`);
await A.keyboard.down('k');
await A.waitForTimeout(800);
const self = await A.$$eval('#hud-voice .hud-voice-entry', (els) => els.map((el) => el.className));
await shot(A, 'a6-self-admin-muted');
await A.keyboard.up('k');
check(self.some((c) => /admin-muted/.test(c)), `A's own entry while admin-muted: ${JSON.stringify(self)}`);

// 3. Unmute.
await openPlayers(B);
button = await clickVoiceButton(B, 'AdmA', 'Mute');
check(button?.text === 'Mute' && button.pressed === 'false', `unmuted: ${JSON.stringify(button)}`);
await closeAdmin(B);
r = await talk(A, B);
check(r.packets > 50, `unmuted: B got ${r.packets} packets`);
const rowB2 = await withScoreboard(B, () => scoreRow(B, 'AdmA'));
check(rowB2 && !rowB2.adminMuted, `crossed-out mic gone: ${JSON.stringify(rowB2)}`);

// 4. sv_voiceenable through the admin API.
const off = await adminAction({ action: 'cvar', name: 'sv_voiceenable', value: 0 });
check(off.status === 200, `sv_voiceenable 0: ${off.status} ${off.body}`);
await A.waitForTimeout(1000);
r = await talk(A, B);
const r2 = await talk(B, A);
check(r.packets === 0 && r2.packets === 0, `voice off: B got ${r.packets}, A got ${r2.packets}`);
const on = await adminAction({ action: 'cvar', name: 'sv_voiceenable', value: 1 });
check(on.status === 200, `sv_voiceenable 1: ${on.status} ${on.body}`);
await A.waitForTimeout(1000);
r = await talk(A, B);
check(r.packets > 50, `voice on again: B got ${r.packets}`);

// 5. B turns Voice chat off: the server sends B nothing.
await B.keyboard.press('F3');
await B.waitForTimeout(300);
await B.click('label:has(#setting-voiceEnabled)');
await B.keyboard.press('F3');
await B.waitForTimeout(500);
r = await talk(A, B);
const out = (await adm(B)).voiceOut;
check(r.packets === 0 && out.includes('{"listen":false}'), `B's Voice chat off: B got ${r.packets} packets; B sent ${JSON.stringify(out)}`);
await B.keyboard.press('F3');
await B.waitForTimeout(300);
await B.click('label:has(#setting-voiceEnabled)');
await B.keyboard.press('F3');
await B.mouse.click(640, 400);
await B.waitForTimeout(500);
r = await talk(A, B);
check(r.packets > 50, `B's Voice chat on again: B got ${r.packets}`);

await browserA.close();
await browserB.close();
process.exit(failures ? 1 : 0);
