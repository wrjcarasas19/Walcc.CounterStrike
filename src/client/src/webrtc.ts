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

  constructor(opts?: Xash3DOptions) {
    super(opts);
    this.net = new Net(this);
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
    let channelsCount = 0;
    peer.ondatachannel = (e) => {
      e.channel.binaryType = 'arraybuffer';
      if (e.channel.label === 'write') {
        e.channel.onmessage = (ee: MessageEvent<ArrayBuffer>) => {
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
      }
      e.channel.onclose = () => {
        this.fail(
          new ConnectError(
            'webrtc',
            `Data channel "${e.channel.label}" closed`
          ),
          peer
        );
      };
      e.channel.onopen = () => {
        if (this.peer !== peer) return;
        channelsCount += 1;
        if (e.channel.label === 'read') {
          this.channel = e.channel;
        }
        if (channelsCount === 2) {
          this.connected = true;
          this.settle()?.resolve();
        }
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
    if (ws) {
      ws.onopen = ws.onerror = ws.onclose = ws.onmessage = null;
      ws.close();
    }
    if (peer) {
      peer.onicecandidate = null;
      peer.onconnectionstatechange = null;
      peer.ondatachannel = null;
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
        await peer.setRemoteDescription(parsed.data);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        this.wsSend('answer', answer);
        if (!this.wasRemote) {
          this.wasRemote = true;
          for (const c of this.candidates) {
            await peer.addIceCandidate(c);
          }
          this.candidates = [];
        }
        break;
      }
      case 'candidate':
        if (this.wasRemote) {
          await peer.addIceCandidate(parsed.data);
        } else {
          this.candidates.push(parsed.data);
        }
        break;
    }
  }

  /**
   * Opens the signaling WebSocket and WebRTC data channels to the game
   * server. Resolves once both channels are open; rejects with a
   * ConnectError. Safe to call again after a failure.
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

  sendto(packet: Packet) {
    if (!this.channel || this.channel.readyState !== 'open') return;
    const data = copyPacketBytes(packet.data);
    if (!data || data.byteLength === 0) return;
    try {
      this.channel.send(data);
    } catch {}
  }
}
