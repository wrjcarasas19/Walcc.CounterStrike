// A.2: voice forwarding with many light clients (no game engine).
//
// usage: pw.sh check-voice-crowd.mjs <clients> [talk windows]
//   Opens <clients> WebRTC connections to the server from one page, each
//   like the page's Xash3DWebRTC (signaling WebSocket, the server's single
//   offer, mic answered sendonly) but without the engine, so many fit on
//   one machine. The server takes a slot for each (the game channel opens)
//   and puts it in the voice hub; the engine never sees them.
//   Talk windows: one per client, "from-to" in seconds after START
//   ("-" or missing: never talks), e.g. "0-20 0-20 0-20 0-20 5-25 -".
//   Talking attaches Chromium's fake microphone (a beep) with replaceTrack
//   and the page's 32 kbit/s cap. Env: START (epoch ms when the timeline
//   starts; default now + 10 s, so several containers can share one),
//   DURATION (s, default 30), LABEL (prefix of the client names in the
//   output). The server allows 4 WebSockets per address: run more clients
//   from several containers (voice-crowd.sh).
//   Prints, per client, its lane events (from the voice data channel) and
//   per second: lanes carrying audio (> 10 packets), packets in / out.
import { chromium } from '../new-features-1006-tools/node_modules/playwright/index.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:27016';
const clients = Number(process.argv[2] ?? 2);
const windows = process.argv.slice(3);
const START = Number(process.env.START ?? Date.now() + 10_000);
const DURATION = Number(process.env.DURATION ?? 30);
const LABEL = process.env.LABEL ?? 'c';

const browser = await chromium.launch({
  headless: true,
  channel: 'chromium',
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    // getUserMedia needs a secure origin: the server's address on a docker
    // network (voice-crowd.sh) isn't localhost.
    `--unsafely-treat-insecure-origin-as-secure=${BASE}`,
  ],
});
const context = await browser.newContext();
await context.grantPermissions(['microphone'], { origin: BASE });
const page = await context.newPage();
page.on('pageerror', (e) => console.log(`[${LABEL} pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' || process.env.VERBOSE) {
    console.log(`[${LABEL} console.${m.type()}] ${m.text()}`);
  }
});
// Same origin as /websocket.
await page.goto(`${BASE}/status.json`);
await page.addScriptTag({
  path: new URL('voice-light-client.js', import.meta.url).pathname,
});

const talk = Array.from({ length: clients }, (_, i) => {
  const w = windows[i];
  if (!w || w === '-') return null;
  const [from, to] = w.split('-').map(Number);
  return { from, to };
});

const results = await page.evaluate(
  async ({ clients, talk, start, duration }) => {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1 },
    });
    const micTrack = mic.getAudioTracks()[0];

    const all = [];
    for (let i = 0; i < clients; i++) all.push(await window.voiceConnect(i));

    const setTalking = async (st, on) => {
      if (!st.mic) return;
      await st.mic.sender.replaceTrack(on ? micTrack.clone() : null);
      if (on) {
        const params = st.mic.sender.getParameters();
        for (const e of params.encodings ?? []) e.maxBitrate = 32000;
        if (params.encodings?.length) await st.mic.sender.setParameters(params);
      }
    };
    const snapshot = async (st) => {
      const lanes = st.laneMids.map(() => 0);
      let out = 0;
      (await st.pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp') {
          const lane = st.laneMids.indexOf(r.mid);
          if (lane >= 0) lanes[lane] = r.packetsReceived ?? 0;
        }
        if (r.type === 'outbound-rtp') out += r.packetsSent ?? 0;
      });
      return { lanes, out };
    };

    const seconds = all.map(() => []);
    let prev = await Promise.all(all.map(snapshot));
    const talking = all.map(() => false);
    const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
    await sleep(start - Date.now());
    for (let sec = 0; sec < duration; sec++) {
      await Promise.all(
        all.map((st, i) => {
          const w = talk[i];
          const on = !!w && sec >= w.from && sec < w.to;
          if (on === talking[i]) return null;
          talking[i] = on;
          return setTalking(st, on);
        }),
      );
      await sleep(start + (sec + 1) * 1000 - Date.now());
      const now = await Promise.all(all.map(snapshot));
      all.forEach((st, i) => {
        const lanes = now[i].lanes.map((n, l) => n - prev[i].lanes[l]);
        seconds[i].push({
          active: lanes.filter((n) => n > 10).length,
          in: lanes.reduce((a, b) => a + b, 0),
          out: now[i].out - prev[i].out,
        });
      });
      prev = now;
    }
    return all.map((st, i) => ({
      index: i,
      connected: !!st.connected,
      voiceChannel: st.voiceChannel,
      laneTracks: st.tracks,
      events: st.events.map((e) => ({
        ...e,
        t: +((e.t - start) / 1000).toFixed(2),
      })),
      seconds: seconds[i],
    }));
  },
  { clients, talk, start: START, duration: DURATION },
);

for (const r of results) {
  const w = talk[r.index];
  console.log(
    `${LABEL}${r.index}: connected ${r.connected}, voice channel ${r.voiceChannel}, ` +
      `talks ${w ? `${w.from}-${w.to} s` : 'never'}, onTrack lanes ${JSON.stringify(r.laneTracks)}`,
  );
  console.log(
    `  events: ${r.events.map((e) => `${e.t}s lane${e.lane}=${e.userid}${e.via === 'ws' ? ' (ws)' : ''}`).join(', ') || 'none'}`,
  );
  console.log(`  active lanes/s: ${r.seconds.map((s) => s.active).join(' ')}`);
  console.log(`  packets in/s:   ${r.seconds.map((s) => s.in).join(' ')}`);
  console.log(`  packets out/s:  ${r.seconds.map((s) => s.out).join(' ')}`);
}
await browser.close();
