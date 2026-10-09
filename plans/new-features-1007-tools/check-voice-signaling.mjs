// A.1: voice audio in the single offer, without renegotiation.
//
// usage: pw.sh check-voice-signaling.mjs [talk]
//   Joins as "VoiceSig" with Chromium's fake microphone and prints:
//   - the audio m-lines of the server's offer and of the page's answer
//     (direction per mid), and whether the page found the mic and lanes
//     (window.__engine is the Xash3DWebRTC instance, see lib.mjs);
//   - 10 s of silence: RTP packets on the audio streams (should be 0),
//     transport and data-channel packets per second, and the ICE round
//     trip, to compare with a server run with VOICE=0 or an old client;
//   - a fake "voice" event fed to the page's signal handler, and what
//     onVoiceLane got.
//   talk: also attaches the fake mic with setMicTrack (replaceTrack, no new
//   offer), checks RTP goes out capped at 32 kbit/s, then detaches it and
//   checks it stops.
// Works against a server or page without voice too (prints "no voice").
import { chromium } from '../new-features-1006-tools/node_modules/playwright/index.mjs';
import {
  newPage,
  joinGame,
  waitForPlayer,
} from '../new-features-1006-tools/lib.mjs';

const talk = process.argv[2] === 'talk';
const name = 'VoiceSig';

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
const page = await newPage(browser, { tag: 'sig' });
await page.context().grantPermissions(['microphone']);
// Keep the PeerConnection and count offers (a second one would be a
// renegotiation).
await page.context().addInitScript(() => {
  window.__sig = { offers: 0, peers: [] };
  const Peer = window.RTCPeerConnection;
  const srd = Peer.prototype.setRemoteDescription;
  Peer.prototype.setRemoteDescription = function (d) {
    if (d?.type === 'offer') window.__sig.offers++;
    if (!window.__sig.peers.includes(this)) window.__sig.peers.push(this);
    return srd.call(this, d);
  };
});

await joinGame(page, { name });
await waitForPlayer(name);

const sdpInfo = await page.evaluate(() => {
  const peer = window.__sig.peers.at(-1);
  const audio = (sdp) =>
    (sdp ?? '')
      .split(/\r?\nm=/)
      .slice(1)
      .map((s) => ({
        media: s.split(' ')[0],
        mid: /\na=mid:(\S+)/.exec(s)?.[1],
        dir: /\na=(sendrecv|sendonly|recvonly|inactive)\b/.exec(s)?.[1],
        opus: /\na=rtpmap:\d+ opus\/48000\/2/.test(s),
      }));
  const e = window.__engine;
  return {
    offers: window.__sig.offers,
    offer: audio(peer?.remoteDescription?.sdp),
    answer: audio(peer?.localDescription?.sdp),
    voiceAvailable: e?.voiceAvailable,
    laneMids: e?.laneMids,
    micMid: e?.mic?.mid,
    micDirection: e?.mic?.direction,
    micCurrentDirection: e?.mic?.currentDirection,
    micTrack: e?.mic?.sender?.track?.kind ?? null,
  };
});
console.log('offers received:', sdpInfo.offers);
console.log('offer m-lines: ', JSON.stringify(sdpInfo.offer));
console.log('answer m-lines:', JSON.stringify(sdpInfo.answer));
console.log(
  sdpInfo.voiceAvailable === undefined
    ? 'page has no voice code (old client)'
    : sdpInfo.voiceAvailable
      ? `voice: mic mid ${sdpInfo.micMid} (${sdpInfo.micDirection}, current ${sdpInfo.micCurrentDirection}, track ${sdpInfo.micTrack}), lanes ${JSON.stringify(sdpInfo.laneMids)}`
      : 'no voice on this connection'
);

const stats = () =>
  page.evaluate(async () => {
    const peer = window.__sig.peers.at(-1);
    const out = {
      rtpOut: 0,
      rtpIn: 0,
      bytesSent: 0,
      bytesRecv: 0,
      pktSent: 0,
      pktRecv: 0,
      rtt: null,
      dcSent: window.__dc.sent,
      dcRecv: window.__dc.received,
    };
    (await peer.getStats()).forEach((r) => {
      if (r.type === 'outbound-rtp') out.rtpOut += r.packetsSent ?? 0;
      if (r.type === 'inbound-rtp') out.rtpIn += r.packetsReceived ?? 0;
      if (
        r.type === 'candidate-pair' &&
        r.nominated &&
        r.state === 'succeeded'
      ) {
        out.bytesSent = r.bytesSent;
        out.bytesRecv = r.bytesReceived;
        out.pktSent = r.packetsSent ?? 0;
        out.pktRecv = r.packetsReceived ?? 0;
        out.rtt = r.currentRoundTripTime;
      }
    });
    return out;
  });
const window_ = async (label, seconds) => {
  const a = await stats();
  await page.waitForTimeout(seconds * 1000);
  const b = await stats();
  const per = (k) => Math.round((b[k] - a[k]) / seconds);
  console.log(
    `${label} (${seconds} s): rtp out ${b.rtpOut - a.rtpOut}, rtp in ${b.rtpIn - a.rtpIn}; ` +
      `transport ${per('pktSent')} pkt/s ${per('bytesSent')} B/s up, ${per('pktRecv')} pkt/s ${per('bytesRecv')} B/s down; ` +
      `data channel ${per('dcSent')}/s up ${per('dcRecv')}/s down; ice rtt ${b.rtt}`
  );
  return b;
};
await page.waitForTimeout(3000);
await window_('silent', 10);

const lanes = await page.evaluate(() => {
  const e = window.__engine;
  if (!e?.handleSignal) return null;
  const got = [];
  const before = e.onVoiceLane;
  e.onVoiceLane = (lane, userid) => got.push({ lane, userid });
  const peer = e.peer;
  return e
    .handleSignal(peer, { event: 'voice', data: { lane: 2, userid: 7 } })
    .then(() =>
      e.handleSignal(peer, { event: 'voice', data: { lane: 2, userid: 0 } })
    )
    .then(() => e.handleSignal(peer, { event: 'voice', data: { lane: 'x' } }))
    .then(() => {
      e.onVoiceLane = before;
      return got;
    });
});
console.log('onVoiceLane from fed voice events:', JSON.stringify(lanes));

if (talk && sdpInfo.voiceAvailable) {
  const result = await page.evaluate(async () => {
    const e = window.__engine;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const ok = await e.setMicTrack(stream.getAudioTracks()[0]);
    const params = e.mic.sender.getParameters();
    window.__talkStream = stream;
    return { ok, maxBitrate: params.encodings?.map((x) => x.maxBitrate) };
  });
  console.log('setMicTrack(fake mic):', JSON.stringify(result));
  await page.waitForTimeout(1000);
  await window_('talking', 5);
  await page.evaluate(async () => {
    await window.__engine.setMicTrack(null);
    window.__talkStream.getTracks().forEach((t) => t.stop());
  });
  await page.waitForTimeout(1000);
  await window_('after setMicTrack(null)', 5);
  console.log(
    'offers received in total:',
    await page.evaluate(() => window.__sig.offers)
  );
}

await browser.close();
