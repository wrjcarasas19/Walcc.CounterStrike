import { Net, type Packet, Xash3D, type Xash3DOptions } from 'xash3d-fwgs';

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
  private ws?: WebSocket;
  private peer?: RTCPeerConnection;
  private candidates: RTCIceCandidateInit[] = [];
  private wasRemote = false;
  private timeout?: ReturnType<typeof setTimeout>;

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
    this.peer.ontrack = (e) => {
      const el = document.createElement(e.track.kind) as HTMLAudioElement;
      el.srcObject = e.streams[0];
      el.autoplay = true;
      el.controls = true;
      document.body.appendChild(el);

      e.track.onmute = () => {
        el.play();
      };

      e.streams[0].onremovetrack = () => {
        if (el.parentNode) {
          el.parentNode.removeChild(el);
        }
      };
    };
    let channelsCount = 0;
    this.peer.ondatachannel = (e) => {
      e.channel.binaryType = 'arraybuffer';
      if (e.channel.label === 'write') {
        e.channel.onmessage = (ee) => {
          const enqueue = (data: Uint8Array) => {
            this.net!.incoming.enqueue({
              ip: [127, 0, 0, 1],
              port: 8080,
              data: new Int8Array(data.buffer, data.byteOffset, data.byteLength),
            });
          };
          const copied = copyPacketBytes(ee.data);
          if (copied) {
            enqueue(copied);
            return;
          }
          const blob = ee.data as { arrayBuffer?: () => Promise<ArrayBuffer> };
          if (typeof blob.arrayBuffer === 'function') {
            blob.arrayBuffer().then((buffer: ArrayBuffer) => {
              const bytes = copyPacketBytes(buffer);
              if (bytes) {
                enqueue(bytes);
              }
            });
          }
        };
      }
      e.channel.onopen = () => {
        channelsCount += 1;
        if (e.channel.label === 'read') {
          this.channel = e.channel;
        }
        if (channelsCount === 2) {
          if (this.resolve) {
            const r = this.resolve;
            this.resolve = undefined;
            if (this.timeout) {
              clearTimeout(this.timeout);
              this.timeout = undefined;
            }
            r();
          }
        }
      };
    };
  }

  private wsSend(event: string, data: unknown) {
    this.ws?.send(
      JSON.stringify({
        event,
        data,
      })
    );
  }

  async connect() {
    return new Promise((resolve) => {
      this.resolve = resolve;
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const host = window.location.host;
      this.ws = new WebSocket(`${protocol}://${host}/websocket`);
      const handler = async (e: MessageEvent) => {
        const parsed = JSON.parse(e.data);
        switch (parsed.event) {
          case 'offer':
            await this.peer!.setRemoteDescription(parsed.data);
            const answer = await this.peer!.createAnswer();
            await this.peer!.setLocalDescription(answer);
            this.wsSend('answer', answer);
            if (!this.wasRemote) {
              this.wasRemote = true;
              this.candidates.forEach((c) => this.peer!.addIceCandidate(c));
              this.candidates = [];
            }
            break;
          case 'candidate':
            if (this.wasRemote) {
              await this.peer!.addIceCandidate(parsed.data);
            } else {
              this.candidates.push(parsed.data);
            }
            break;
        }
      };
      this.ws!.onopen = () => {
        this.initConnection();
      };
      this.ws.addEventListener('message', handler);
    });
  }

  sendto(packet: Packet) {
    if (!this.channel || this.channel.readyState !== 'open') return;
    const data = copyPacketBytes(packet.data);
    if (!data || data.byteLength === 0) return;
    try {
      this.channel.send(data);
    } catch {
      // Channel can throw if the SCTP send buffer is full; drop like UDP.
    }
  }
}
