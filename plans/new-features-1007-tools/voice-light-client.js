// A light voice client for the A.2 checks, loaded into a page of the
// server's origin (page.addScriptTag): what the page's Xash3DWebRTC does
// for voice (signaling WebSocket, the server's single offer, the mic
// answered sendonly, the "voice" data channel), without the engine.
// window.voiceConnect(index) resolves once the game data channel is open
// (the server has given it a slot and put it in the voice hub) with
// { pc, mic (the mic transceiver), laneMids, tracks (ontrack lanes),
// events (lane events: t, lane, userid, via 'dc' or 'ws'), voiceChannel }.
const sections = (sdp) =>
  sdp
    .split(/\r?\nm=/)
    .slice(1)
    .map((s) => ({
      media: s.split(' ')[0],
      mid: /\na=mid:(\S+)/.exec(s)?.[1],
      dir: /\na=(sendrecv|sendonly|recvonly|inactive)\b/.exec(s)?.[1],
    }));

window.voiceConnect = (index) =>
  new Promise((resolve) => {
    const st = {
      index,
      connected: null,
      voiceChannel: false,
      events: [],
      tracks: [],
      laneMids: [],
      mic: null,
      pc: null,
    };
    const ws = new WebSocket(`ws://${location.host}/websocket`);
    const pc = new RTCPeerConnection();
    st.pc = pc;
    const pending = [];
    let answered = false;
    let chain = Promise.resolve();
    const send = (event, data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ event, data }));
      }
    };
    pc.onicecandidate = (e) =>
      e.candidate && send('candidate', e.candidate.toJSON());
    pc.ontrack = (e) => st.tracks.push(st.laneMids.indexOf(e.transceiver.mid));
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      if (ch.label === 'game') {
        ch.onopen = () => {
          st.connected = Date.now();
          resolve(st);
        };
      } else if (ch.label === 'voice') {
        ch.onopen = () => (st.voiceChannel = true);
        ch.onmessage = (m) => {
          const p = JSON.parse(m.data);
          if (p.event === 'voice') {
            st.events.push({ t: Date.now(), via: 'dc', ...p.data });
          }
        };
      }
    };
    const handle = async (p) => {
      if (p.event === 'offer') {
        const s = sections(p.data.sdp);
        const micMid = s.find(
          (x) => x.media === 'audio' && x.dir === 'recvonly',
        )?.mid;
        st.laneMids = s
          .filter((x) => x.media === 'audio' && x.dir === 'sendonly')
          .map((x) => x.mid);
        await pc.setRemoteDescription(p.data);
        st.mic = pc.getTransceivers().find((t) => t.mid === micMid);
        if (st.mic) st.mic.direction = 'sendonly';
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send('answer', answer);
        answered = true;
        for (const c of pending.splice(0)) await pc.addIceCandidate(c);
      } else if (p.event === 'candidate') {
        if (answered) await pc.addIceCandidate(p.data);
        else pending.push(p.data);
      } else if (p.event === 'voice') {
        st.events.push({ t: Date.now(), via: 'ws', ...p.data });
      }
    };
    ws.onmessage = (m) => {
      const p = JSON.parse(m.data);
      chain = chain.then(() => handle(p)).catch((e) => console.error(e));
    };
    setTimeout(() => resolve(st), 30000);
  });
