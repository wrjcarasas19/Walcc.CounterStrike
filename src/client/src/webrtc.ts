import { Net, type Packet, Xash3D, type Xash3DOptions } from 'xash3d-fwgs';

// How long signaling + ICE + the game data channel may take before connect fails.
const CONNECT_TIMEOUT_MS = 20_000;
// Packets pile up while the tab is throttled; anything past this is stale.
const MAX_INCOMING_PACKETS = 512;

function copyPacketBytes(data: unknown): Uint8Array<ArrayBuffer> | null {
  let src: Uint8Array | null = null;
  if (data instanceof ArrayBuffer) {
    src = new Uint8Array(data);
  } else if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    src = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (!src) {
    return null;
  }
  const copy = new Uint8Array(src.byteLength);
  copy.set(src);
  return copy;
}

// Must match the engine's defaults (INITIAL_MEMORY 128 MiB, 2 GiB max).
const WASM_INITIAL_PAGES = 134217728 / 65536;
const WASM_MAXIMUM_PAGES = 32768;

/**
 * The library's Net reads em.HEAPU8 and friends, which the emscripten glue
 * snapshots once at startup. Memory growth (e.g. loading a new map after
 * changelevel) detaches those views and sendto throws. Serve views that are
 * rebuilt whenever the memory buffer changes.
 */
class LiveHeapNet extends Net {
  private readonly memory: WebAssembly.Memory;

  constructor(
    sender: ConstructorParameters<typeof Net>[0],
    memory: WebAssembly.Memory
  ) {
    super(sender);
    this.memory = memory;
  }

  init(em: NonNullable<Net['em']>) {
    const memory = this.memory;
    let buffer: ArrayBuffer | undefined;
    let views: Record<'HEAP8' | 'HEAPU8' | 'HEAP16' | 'HEAP32', unknown>;
    const current = () => {
      if (memory.buffer !== buffer) {
        buffer = memory.buffer;
        views = {
          HEAP8: new Int8Array(buffer),
          HEAPU8: new Uint8Array(buffer),
          HEAP16: new Int16Array(buffer),
          HEAP32: new Int32Array(buffer),
        };
      }
      return views;
    };
    const live = Object.create(em, {
      HEAP8: { get: () => current().HEAP8 },
      HEAPU8: { get: () => current().HEAPU8 },
      HEAP16: { get: () => current().HEAP16 },
      HEAP32: { get: () => current().HEAP32 },
    });
    super.init(live);
  }
}

/** Opus bitrate cap for the microphone, in bit/s. */
export const VOICE_MAX_BITRATE = 32_000;

/** getUserMedia audio constraints for voice chat (mono, browser cleanup on). */
export const VOICE_MIC_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * The voice m-lines of the server's offer (src/server/voice.go): the mic is
 * the audio m-line the server only receives on, the lanes the ones it only
 * sends on, lane 0 first. Empty when the server has voice off.
 */
export function voiceMids(sdp: string): { mic?: string; lanes: string[] } {
  const result: { mic?: string; lanes: string[] } = { lanes: [] };
  for (const section of sdp.split(/\r?\nm=/).slice(1)) {
    if (!section.startsWith('audio ')) continue;
    const mid = /\na=mid:(\S+)/.exec(section)?.[1];
    if (mid === undefined) continue;
    if (/\na=recvonly\b/.test(section)) {
      result.mic ??= mid;
    } else if (/\na=sendonly\b/.test(section)) {
      result.lanes.push(mid);
    }
  }
  return result;
}

export type ConnectErrorKind =
  // The signaling WebSocket never opened (server down, refused or rate limited).
  | 'unreachable'
  // The signaling WebSocket closed before WebRTC finished.
  | 'closed'
  // Signaling worked but WebRTC never came up (usually UDP blocked).
  | 'timeout'
  | 'webrtc';

export class ConnectError extends Error {
  readonly kind: ConnectErrorKind;

  constructor(kind: ConnectErrorKind, message: string) {
    super(message);
    this.name = 'ConnectError';
    this.kind = kind;
  }
}

export class Xash3DWebRTC extends Xash3D {
  /** Called when an established connection to the game server is lost. */
  onDisconnect?: (error: Error) => void;
  /** Voice: `userid` is now on `lane` (0 when the lane goes quiet). */
  onVoiceLane?: (lane: number, userid: number) => void;
  /** Voice: the incoming audio of `lane` (once per connection). */
  onVoiceTrack?: (
    lane: number,
    track: MediaStreamTrack,
    receiver: RTCRtpReceiver
  ) => void;
  /**
   * Voice: the userids the admin has muted, the whole list each time
   * (`{"event":"voice","data":{"muted":[3,7]}}`, A.6).
   */
  onVoiceMuted?: (userids: number[]) => void;

  private channel?: RTCDataChannel;
  private resolve?: () => void;
  private reject?: (reason: Error) => void;
  private ws?: WebSocket;
  private peer?: RTCPeerConnection;
  private candidates: RTCIceCandidateInit[] = [];
  private wasRemote = false;
  private timeout?: ReturnType<typeof setTimeout>;
  private connected = false;
  private signaling: Promise<void> = Promise.resolve();
  // Voice transceivers of the current connection (none without voice).
  private mic?: RTCRtpTransceiver;
  private laneMids: string[] = [];
  // The "voice" data channel of the current connection, and whether this
  // page wants lane audio (kept across connections; setVoiceListening).
  private voiceChannel?: RTCDataChannel;
  private voiceListening = true;

  constructor(opts?: Xash3DOptions) {
    const memory = new WebAssembly.Memory({
      initial: WASM_INITIAL_PAGES,
      maximum: WASM_MAXIMUM_PAGES,
    });
    super({
      ...opts,
      module: { ...opts?.module, wasmMemory: memory } as Xash3DOptions['module'],
    });
    this.net = new LiveHeapNet(this, memory);
  }

  private initConnection() {
    if (this.peer) return;

    const peer = new RTCPeerConnection();
    this.peer = peer;
    peer.onicecandidate = (e) => {
      if (!e.candidate) {
        return;
      }
      this.wsSend('candidate', e.candidate.toJSON());
    };
    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      if (state === 'failed' || state === 'closed') {
        this.fail(
          new ConnectError('webrtc', `WebRTC connection ${state}`),
          peer
        );
      }
    };
    peer.ontrack = (e) => {
      if (this.peer !== peer) return;
      const lane = this.laneMids.indexOf(e.transceiver.mid ?? '');
      if (lane >= 0) this.onVoiceTrack?.(lane, e.track, e.receiver);
    };
    peer.ondatachannel = (e) => {
      const channel = e.channel;
      if (channel.label === 'voice') {
        // Lane events, once this channel is open (the signaling socket
        // may be gone by then).
        channel.onmessage = (ee: MessageEvent<string>) => {
          if (this.peer !== peer) return;
          try {
            const parsed = JSON.parse(ee.data);
            if (parsed?.event === 'voice') this.voiceLane(parsed.data);
          } catch {}
        };
        // The page's requests go back on it; the server assumes a page
        // listens until told otherwise.
        this.voiceChannel = channel;
        const opened = () => {
          if (this.peer === peer && !this.voiceListening) {
            this.voiceSend({ listen: false });
          }
        };
        if (channel.readyState === 'open') opened();
        else channel.onopen = opened;
        return;
      }
      if (channel.label !== 'game') return;
      channel.binaryType = 'arraybuffer';
      channel.onmessage = (ee: MessageEvent<ArrayBuffer>) => {
        if (this.peer !== peer) return;
        const incoming = this.net!.incoming;
        while (
          (incoming as unknown as { size: number }).size >=
          MAX_INCOMING_PACKETS
        ) {
          incoming.dequeue();
        }
        incoming.enqueue({
          ip: [127, 0, 0, 1],
          port: 8080,
          data: new Int8Array(ee.data),
        });
      };
      channel.onclose = () => {
        this.fail(
          new ConnectError('webrtc', 'Game data channel closed'),
          peer
        );
      };
      channel.onopen = () => {
        if (this.peer !== peer) return;
        this.channel = channel;
        this.connected = true;
        this.settle()?.resolve();
      };
    };
  }

  private settle() {
    if (!this.resolve || !this.reject) return undefined;
    const callbacks = { resolve: this.resolve, reject: this.reject };
    this.resolve = undefined;
    this.reject = undefined;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
    return callbacks;
  }

  // Closes the current WebSocket and peer without firing their handlers.
  private teardown() {
    const { ws, peer } = this;
    this.ws = undefined;
    this.peer = undefined;
    this.channel = undefined;
    this.voiceChannel = undefined;
    this.mic = undefined;
    this.laneMids = [];
    if (ws) {
      ws.onopen = ws.onerror = ws.onclose = ws.onmessage = null;
      ws.close();
    }
    if (peer) {
      peer.onicecandidate = null;
      peer.onconnectionstatechange = null;
      peer.ondatachannel = null;
      peer.ontrack = null;
      peer.close();
    }
  }

  // `peer` is the connection the event came from; events from a connection
  // that has already been replaced or torn down are ignored.
  private fail(error: Error, peer?: RTCPeerConnection) {
    if (peer && peer !== this.peer) return;
    const pending = this.settle();
    const wasConnected = this.connected;
    this.connected = false;
    this.teardown();
    if (pending) {
      pending.reject(error);
    } else if (wasConnected) {
      console.warn('Connection to server lost:', error.message);
      this.onDisconnect?.(error);
    }
  }

  /**
   * Drops the connection on purpose: onDisconnect runs as for a lost one,
   * so main.ts opens a new connection (a new signaling WebSocket, which
   * carries the current cookies) and joins again.
   */
  rejoin() {
    if (this.connected) this.fail(new Error('Rejoining'), this.peer);
  }

  private wsSend(event: string, data: unknown) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        event,
        data,
      })
    );
  }

  private async handleSignal(
    peer: RTCPeerConnection,
    parsed: { event: string; data: any }
  ) {
    if (this.peer !== peer) return;
    switch (parsed.event) {
      case 'offer': {
        // Known before setRemoteDescription, which fires ontrack.
        const voice = voiceMids(parsed.data.sdp ?? '');
        this.laneMids = voice.lanes;
        await peer.setRemoteDescription(parsed.data);
        // The mic is answered as sendonly so a track can be attached later
        // with replaceTrack, without renegotiating; with no track nothing
        // is sent.
        const mic = peer.getTransceivers().find((t) => t.mid === voice.mic);
        if (mic) mic.direction = 'sendonly';
        this.mic = mic;
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        this.wsSend('answer', answer);
        if (mic) await this.limitMicSender();
        if (!this.wasRemote) {
          this.wasRemote = true;
          for (const c of this.candidates) {
            await peer.addIceCandidate(c);
          }
          this.candidates = [];
        }
        break;
      }
      case 'voice':
        this.voiceLane(parsed.data);
        break;
      case 'candidate':
        if (this.wasRemote) {
          await peer.addIceCandidate(parsed.data);
        } else {
          this.candidates.push(parsed.data);
        }
        break;
    }
  }

  // A "voice" event, from the signaling socket or the voice data channel:
  // a lane change ({lane, userid}) or the admin-muted list ({muted}).
  private voiceLane(data: any) {
    const { lane, userid, muted } = data ?? {};
    if (Number.isInteger(lane) && Number.isInteger(userid)) {
      this.onVoiceLane?.(lane, userid);
    }
    if (Array.isArray(muted)) {
      this.onVoiceMuted?.(
        muted.filter((id: unknown) => Number.isInteger(id) && Number(id) > 0)
      );
    }
  }

  /**
   * Opens the signaling WebSocket and the WebRTC data channel to the game
   * server. Resolves once the channel is open; rejects with a ConnectError.
   * Safe to call again after a failure.
   */
  connect(): Promise<void> {
    this.settle()?.reject(new ConnectError('closed', 'Connect restarted'));
    this.teardown();
    this.connected = false;
    this.candidates = [];
    this.wasRemote = false;
    this.signaling = Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;

      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const host = window.location.host;
      const ws = new WebSocket(`${protocol}://${host}/websocket`);
      this.ws = ws;
      let opened = false;

      this.timeout = setTimeout(() => {
        this.fail(
          opened
            ? new ConnectError(
                'timeout',
                'Timed out establishing the WebRTC connection'
              )
            : new ConnectError(
                'unreachable',
                'Timed out opening the signaling WebSocket'
              )
        );
      }, CONNECT_TIMEOUT_MS);

      // A browser can't see why a WebSocket handshake failed (e.g. HTTP 429
      // or 403), so all failures before `open` count as unreachable.
      const lost = () => {
        if (this.ws !== ws) return;
        if (this.connected) {
          // The game runs over WebRTC; the signaling socket is not needed
          // once connected, so losing it is not a disconnect.
          this.ws = undefined;
          return;
        }
        this.fail(
          opened
            ? new ConnectError('closed', 'Signaling WebSocket closed')
            : new ConnectError('unreachable', 'Signaling WebSocket failed')
        );
      };
      ws.onopen = () => {
        opened = true;
        this.initConnection();
      };
      ws.onerror = lost;
      ws.onclose = lost;
      ws.onmessage = (e: MessageEvent) => {
        const peer = this.peer;
        if (!peer) return;
        const parsed = JSON.parse(e.data);
        this.signaling = this.signaling
          .then(() => this.handleSignal(peer, parsed))
          .catch((error) => {
            console.error(`Failed to handle "${parsed.event}" signal:`, error);
          });
      };
    });
  }

  /** Whether the server offered voice on the current connection. */
  get voiceAvailable(): boolean {
    return !!this.mic;
  }

  /**
   * Whether the server should send this page lane audio: false while the
   * Voice chat setting is off, so no bandwidth goes on voice nobody plays.
   * Kept for later connections (sent when their voice channel opens).
   */
  setVoiceListening(listening: boolean) {
    if (listening === this.voiceListening) return;
    this.voiceListening = listening;
    this.voiceSend({ listen: listening });
  }

  // Sends a request to the server on the voice data channel (dropped when
  // it isn't open; old servers ignore it).
  private voiceSend(message: Record<string, unknown>) {
    const channel = this.voiceChannel;
    if (channel?.readyState !== 'open') return;
    try {
      channel.send(JSON.stringify(message));
    } catch {}
  }

  /**
   * Sends `track` (from getUserMedia with VOICE_MIC_CONSTRAINTS) as the
   * microphone, or stops sending with null. No renegotiation. Resolves
   * false when the connection has no voice.
   */
  async setMicTrack(track: MediaStreamTrack | null): Promise<boolean> {
    const mic = this.mic;
    if (!mic) return false;
    await mic.sender.replaceTrack(track);
    if (track) await this.limitMicSender();
    return true;
  }

  // Caps the mic's bitrate. Some browsers have no encodings until a track
  // is attached, so this runs again then.
  private async limitMicSender() {
    const sender = this.mic?.sender;
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) return;
      if (params.encodings.every((e) => e.maxBitrate === VOICE_MAX_BITRATE)) {
        return;
      }
      for (const encoding of params.encodings) {
        encoding.maxBitrate = VOICE_MAX_BITRATE;
      }
      await sender.setParameters(params);
    } catch (error) {
      console.warn('Could not cap the voice bitrate:', error);
    }
  }

  sendto(packet: Packet) {
    if (!this.channel || this.channel.readyState !== 'open') return;
    const data = copyPacketBytes(packet.data);
    if (!data || data.byteLength === 0) return;
    try {
      this.channel.send(data);
    } catch {}
  }
}
