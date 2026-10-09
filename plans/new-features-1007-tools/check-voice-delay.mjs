// A.2: the delay voice forwarding adds.
//
// usage: pw.sh check-voice-delay.mjs [beeps]
//   One page of the server's origin with two light clients
//   (voice-light-client.js), so both ends share a clock and no engine
//   competes for the CPU. A Web Audio beep (880 Hz, 200 ms, once a second;
//   no audio processing in the way) is sent as A's mic; the beep's start is
//   detected with an AnalyserNode polled every 2 ms on what A sends and on
//   B's lanes (each through a muted <audio>, which Chrome needs to decode a
//   remote track). B's onset minus A's is mouth to ear: Opus, network, the
//   server, B's jitter buffer and decoding.
//   Then the same beeps over a direct connection between two
//   RTCPeerConnections in the page (no server): the difference between the
//   two is what the server adds.
import { chromium } from '../new-features-1006-tools/node_modules/playwright/index.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:27016';
const beeps = Number(process.argv[2] ?? 10);

const browser = await chromium.launch({
  headless: true,
  channel: 'chromium',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[console.error] ${m.text()}`);
});
await page.goto(`${BASE}/status.json`);
await page.addScriptTag({
  path: new URL('voice-light-client.js', import.meta.url).pathname,
});

const result = await page.evaluate(async (beeps) => {
  const ctx = new AudioContext();
  await ctx.resume();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Records the start of each beep heard on node (after 300 ms of quiet).
  const watch = (node) => {
    const onsets = [];
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    node.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let quietSince = performance.now();
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      const now = performance.now();
      if (peak > 0.1) {
        if (now - quietSince > 300) onsets.push(now);
        quietSince = Infinity;
      } else if (quietSince === Infinity) {
        quietSince = now;
      }
    }, 2);
    return { onsets, stop: () => clearInterval(timer) };
  };
  const hear = (track) => {
    const stream = new MediaStream([track]);
    const audio = new Audio();
    audio.srcObject = stream;
    audio.muted = true;
    audio.play().catch(() => {});
    return watch(ctx.createMediaStreamSource(stream));
  };

  // The beeps, as a mic track.
  const osc = ctx.createOscillator();
  osc.frequency.value = 880;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  osc.connect(gain);
  osc.start();
  const dest = ctx.createMediaStreamDestination();
  gain.connect(dest);
  const track = dest.stream.getAudioTracks()[0];

  const run = async (heardTracks) => {
    const sent = watch(gain);
    const heard = heardTracks.map(hear);
    await sleep(1000);
    const t0 = ctx.currentTime + 0.5;
    for (let i = 0; i < beeps; i++) {
      gain.gain.setValueAtTime(0.8, t0 + i);
      gain.gain.setValueAtTime(0, t0 + i + 0.2);
    }
    await sleep(beeps * 1000 + 1500);
    sent.stop();
    heard.forEach((h) => h.stop());
    const onsets = heard.flatMap((h) => h.onsets).sort((a, b) => a - b);
    return sent.onsets.map((s) => {
      const h = onsets.find((x) => x > s && x < s + 900);
      return h === undefined ? null : Math.round(h - s);
    });
  };

  // Through the server.
  const a = await window.voiceConnect(0);
  const b = await window.voiceConnect(1);
  if (!a.mic || !b.connected) return { error: 'not connected / no voice' };
  await a.mic.sender.replaceTrack(track);
  const laneTracks = b.pc
    .getTransceivers()
    .filter((t) => b.laneMids.includes(t.mid))
    .map((t) => t.receiver.track);
  const viaServer = await run(laneTracks);
  await a.mic.sender.replaceTrack(null);
  const stats = [];
  (await b.pc.getStats()).forEach((r) => {
    if (r.type === 'inbound-rtp' && r.jitterBufferEmittedCount) {
      stats.push({
        lane: b.laneMids.indexOf(r.mid),
        jitterBufferMs: Math.round(
          (1000 * r.jitterBufferDelay) / r.jitterBufferEmittedCount,
        ),
        lost: r.packetsLost,
      });
    }
  });
  const rtt = [];
  (await b.pc.getStats()).forEach((r) => {
    if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') {
      rtt.push(r.currentRoundTripTime);
    }
  });

  // Direct, for comparison.
  const x = new RTCPeerConnection();
  const y = new RTCPeerConnection();
  x.onicecandidate = (e) => e.candidate && y.addIceCandidate(e.candidate);
  y.onicecandidate = (e) => e.candidate && x.addIceCandidate(e.candidate);
  const got = new Promise((r) => (y.ontrack = (e) => r(e.track)));
  x.addTrack(track.clone());
  await x.setLocalDescription();
  await y.setRemoteDescription(x.localDescription);
  await y.setLocalDescription();
  await x.setRemoteDescription(y.localDescription);
  const direct = await run([await got]);
  return { viaServer, direct, stats, rtt };
}, beeps);

if (result.error) {
  console.log(result.error);
} else {
  const median = (xs) => {
    const v = xs.filter((n) => n !== null).sort((p, q) => p - q);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };
  console.log(`through the server (ms): ${JSON.stringify(result.viaServer)}`);
  console.log(`direct (ms):             ${JSON.stringify(result.direct)}`);
  console.log(
    `median: server ${median(result.viaServer)} ms, direct ${median(result.direct)} ms, ` +
      `added ${median(result.viaServer) - median(result.direct)} ms`,
  );
  console.log(
    `B's lanes: ${JSON.stringify(result.stats)}; ICE rtt to the server ${result.rtt} s`,
  );
}
await browser.close();
