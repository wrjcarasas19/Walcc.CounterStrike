import { Net, type Packet, Xash3D, type Xash3DOptions } from 'xash3d-fwgs';

// How long signaling + ICE + both data channels may take before init fails.
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

export class Xash3DWebRTC extends Xash3D {
  private channel?: RTCDataChannel;
  private resolve?: (value?: unknown) => void;
  private reject?: (reason: Error) => void;
  private ws?: WebSocket;
  private peer?: RTCPeerConnection;
  private candidates: RTCIceCandidateInit[] = [];
  private wasRemote = false;
  private timeout?: ReturnType<typeof setTimeout>;
  private disconnected = false;
  // Signaling messages are handled one at a time so overlapping offers
  // can't interleave setRemoteDescription/createAnswer.
  private signaling: Promise<void> = Promise.resolve();

  constructor(opts?: Xash3DOptions) {
    super(opts);
    this.net = new Net(this);
  }

  async init() {
    await Promise.all([super.init(), this.connect()]);
  }

  initConnection() {
    if (this.peer) return;

    this.peer = new RTCPeerConnection();
    this.peer.onicecandidate = (e) => {
      if (!e.candidate) {
        return;
      }
      this.wsSend('candidate', e.candidate.toJSON());
    };
    this.peer.onconnectionstatechange = () => {
      const state = this.peer?.connectionState;
      if (state === 'failed' || state === 'closed') {
        this.fail(new Error(`WebRTC connection ${state}`));
      }
    };
    let channelsCount = 0;
    this.peer.ondatachannel = (e) => {
      e.channel.binaryType = 'arraybuffer';
      if (e.channel.label === 'write') {
        e.channel.onmessage = (ee: MessageEvent<ArrayBuffer>) => {
          const incoming = this.net!.incoming;
          // `size` is private in the typings but public at runtime.
          while ((incoming as unknown as { size: number }).size >= MAX_INCOMING_PACKETS) {
            incoming.dequeue();
          }
          // binaryType is 'arraybuffer', so each message is already a fresh buffer.
          incoming.enqueue({
            ip: [127, 0, 0, 1],
            port: 8080,
            data: new Int8Array(ee.data),
          });
        };
      }
      e.channel.onclose = () => {
        this.fail(new Error(`Data channel "${e.channel.label}" closed`));
      };
      e.channel.onopen = () => {
        channelsCount += 1;
        if (e.channel.label === 'read') {
          this.channel = e.channel;
        }
        if (channelsCount === 2) {
          this.settle()?.resolve();
        }
      };
    };
  }

  // Clears the pending connect() callbacks so it resolves or rejects only once.
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

  private fail(error: Error) {
    if (this.disconnected) return;
    this.disconnected = true;
    const pending = this.settle();
    if (pending) {
      this.ws?.close();
      this.peer?.close();
      pending.reject(error);
      return;
    }
    // Already connected: the engine notices the silence and times out on its own.
    console.warn('Connection to server lost:', error.message);
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

  private async handleSignal(parsed: { event: string; data: any }) {
    switch (parsed.event) {
      case 'offer': {
        await this.peer!.setRemoteDescription(parsed.data);
        const answer = await this.peer!.createAnswer();
        await this.peer!.setLocalDescription(answer);
        this.wsSend('answer', answer);
        if (!this.wasRemote) {
          this.wasRemote = true;
          for (const c of this.candidates) {
            await this.peer!.addIceCandidate(c);
          }
          this.candidates = [];
        }
        break;
      }
      case 'candidate':
        if (this.wasRemote) {
          await this.peer!.addIceCandidate(parsed.data);
        } else {
          this.candidates.push(parsed.data);
        }
        break;
    }
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.timeout = setTimeout(() => {
        this.fail(new Error('Timed out connecting to the game server'));
      }, CONNECT_TIMEOUT_MS);

      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const host = window.location.host;
      this.ws = new WebSocket(`${protocol}://${host}/websocket`);
      this.ws.onopen = () => {
        this.initConnection();
      };
      this.ws.onerror = () => {
        this.fail(new Error('Signaling WebSocket error'));
      };
      this.ws.onclose = () => {
        this.fail(new Error('Signaling WebSocket closed'));
      };
      this.ws.onmessage = (e: MessageEvent) => {
        const parsed = JSON.parse(e.data);
        this.signaling = this.signaling
          .then(() => this.handleSignal(parsed))
          .catch((error) => {
            console.error(`Failed to handle "${parsed.event}" signal:`, error);
          });
      };
    });
  }

  sendto(packet: Packet) {
    if (!this.channel || this.channel.readyState !== 'open') return;
    const data = copyPacketBytes(packet.data);
    if (!data || data.byteLength === 0) return;
    try {
      this.channel.send(data);
    } catch {
    }
  }
}
