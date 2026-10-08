import { onHudEvent } from './hud';
import { anyModalOpen } from './modal';
import {
  onSettingsPanel,
  setDeviceOptions,
  settingsGroupFields,
} from './settings';
import type { Settings } from './settings/schema';
import { getSettings, onSettingsChange } from './settings/store';
import { VOICE_MIC_CONSTRAINTS, type Xash3DWebRTC } from './webrtc';

// Voice chat (new-features-1007 A.4): push to talk over the game's WebRTC
// connection, and playback of the voice lanes the server sends
// (src/server/voice_forward.go decides who hears whom).
//
// - Talking: hold the key from the settings (K by default) or, with touch
//   controls, the microphone button. The microphone is asked for on the
//   first press, never before; the track is attached to the connection's
//   mic sender while held and detached RELEASE_TAIL_MS after letting go
//   (webrtc.ts setMicTrack: replaceTrack, no renegotiation). The capture
//   itself stays open MIC_IDLE_MS after the last use, so the next press
//   starts at once, then it is stopped (the browser's recording indicator
//   goes off).
// - Keys: the capture listener below is registered after modal.ts's and
//   chat.ts's (main.ts imports ./chat first) and before the engine's, so an
//   open menu or chat input keeps the key (K types "k" there), and
//   otherwise the engine never sees it. The engine's own voice is off
//   (engine.ts starts it with voice_enable 0, so it never opens the
//   microphone) and its K bind (+voicerecord) is removed in attachVoice.
// - Playback: each lane's track goes through a Web Audio gain (per player,
//   for A.5's mutes) into a master gain (the Voice volume setting).
// - Settings: Voice chat off means no microphone and nothing played.

/** Sending goes on this long after the key is let go. */
const RELEASE_TAIL_MS = 200;
/** The microphone is closed after this long without talking or a test. */
const MIC_IDLE_MS = 30_000;
const NOTICE_MS = 6_000;
/** The microphone test stops by itself after this long. */
const TEST_MS = 20_000;
/**
 * A lane that played nothing from its speaker for this long counts as not
 * talking (the speaking indicators), long before the server announces it
 * quiet (500 ms after the last packet, voice_forward.go). Opus sends a
 * packet every 20 ms while the key is held, and the time is taken after the
 * jitter buffer, so ordinary network jitter doesn't count.
 */
const LANE_SILENT_MS = 70;
/** How often the lanes' last packets are looked at while anyone talks. */
const ACTIVITY_POLL_MS = 20;

const BLOCKED_HELP =
  'Allow the microphone for this site: click the icon at the left of the ' +
  "address bar (Safari: Settings for This Website; on a phone, the browser's " +
  'site settings), then try again.';
const INSECURE_HELP = 'Voice chat needs the page to be opened over https.';

export type VoiceEvent =
  /**
   * `userid` (the engine's) is now heard on `lane`; 0: the lane is quiet.
   * `active` false: the lane still belongs to userid but nothing has come
   * from them for LANE_SILENT_MS (they let go of the key); the same event
   * without it says their packets come again.
   */
  | { type: 'lane'; lane: number; userid: number; active?: boolean }
  /** The local player started or stopped sending. */
  | { type: 'talking'; talking: boolean }
  /** The userids the admin has muted (the whole list; A.6 sends it). */
  | { type: 'muted'; userids: number[] };

type Holder = 'key' | 'touch';

type Lane = {
  userid: number;
  /** Packets from userid are arriving (see LANE_SILENT_MS). */
  active: boolean;
  receiver?: RTCRtpReceiver;
  /** Last packet's time seen from the receiver, and when it last changed. */
  packetTime?: number;
  packetSeen?: number;
  /** When userid's lane event came (their first packets may still be in
   *  the jitter buffer then). */
  since?: number;
  /** Plays nothing; Chrome only feeds a remote track to Web Audio while a
   *  media element plays it. */
  element?: HTMLAudioElement;
  source?: MediaStreamAudioSourceNode;
  gain?: GainNode;
};

const button = document.getElementById('voice-button') as HTMLButtonElement;
const notice = document.getElementById('hud-voice-notice')!;
const noticeTitle = document.getElementById('hud-voice-notice-title')!;
const noticeText = document.getElementById('hud-voice-notice-text')!;

let engine: Xash3DWebRTC | undefined;
/** In game (attachVoice): keys and the touch button talk. */
let inGame = false;
let touchControls = false;
let gameMenuOpen = false;

const listeners = new Set<(event: VoiceEvent) => void>();
let playerGain: (userid: number) => number = () => 1;

// Talking.
const holders = new Set<Holder>();
/** KeyboardEvent.code of the held talk key. */
let heldCode: string | undefined;
let touchPointer: number | undefined;
let talking = false;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

// The microphone.
let mic: MediaStream | undefined;
let micOpening: Promise<MediaStreamTrack | undefined> | undefined;
/** Bumped when the microphone is closed, so an open in progress is dropped. */
let micGeneration = 0;
let micIdleTimer: ReturnType<typeof setTimeout> | undefined;
type MicProblem = 'blocked' | 'insecure' | 'missing' | 'failed';
let micProblem: MicProblem | undefined;
/** Microphones were listed with their names (permission given). */
let devicesListed = false;
/** The microphone test in the settings is running. */
let testing = false;

// Playback.
let audio: AudioContext | undefined;
let master: GainNode | undefined;
const lanes: Lane[] = [];
let activityTimer: ReturnType<typeof setInterval> | undefined;
/** Admin-muted userids, from the server (cleared with each connection). */
let adminMuted: number[] = [];

let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function emit(event: VoiceEvent): void {
  for (const listener of listeners) listener(event);
}

function enabled(): boolean {
  return getSettings().voiceEnabled;
}

/** Talking is possible: in game, voice on, and the server offered voice. */
function canTalk(): boolean {
  return inGame && enabled() && !!engine?.voiceAvailable;
}

function showNotice(title: string, text: string): void {
  noticeTitle.textContent = title;
  noticeText.textContent = text;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.hidden = true), NOTICE_MS);
}

function hideNotice(): void {
  clearTimeout(noticeTimer);
  notice.hidden = true;
}

// --- The microphone ---------------------------------------------------

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : '';
}

async function requestMic(device: string): Promise<MediaStream> {
  const devices = navigator.mediaDevices;
  if (device) {
    try {
      return await devices.getUserMedia({
        audio: { ...VOICE_MIC_CONSTRAINTS, deviceId: { exact: device } },
      });
    } catch (error) {
      // The saved microphone is gone: use the default one.
      const name = errorName(error);
      if (name !== 'OverconstrainedError' && name !== 'NotFoundError') {
        throw error;
      }
    }
  }
  return devices.getUserMedia({ audio: VOICE_MIC_CONSTRAINTS });
}

function setMicProblem(problem: MicProblem | undefined): void {
  micProblem = problem;
  renderTest();
}

async function openMic(): Promise<MediaStreamTrack | undefined> {
  if (!navigator.mediaDevices?.getUserMedia) {
    setMicProblem('insecure');
    showNotice('Microphone unavailable', INSECURE_HELP);
    return;
  }
  const generation = micGeneration;
  let stream: MediaStream;
  try {
    stream = await requestMic(getSettings().voiceInput);
  } catch (error) {
    const name = errorName(error);
    if (generation !== micGeneration) return;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      setMicProblem('blocked');
      showNotice('Microphone blocked', BLOCKED_HELP);
    } else if (name === 'NotFoundError') {
      setMicProblem('missing');
      showNotice('No microphone', 'Plug in a microphone and try again.');
    } else {
      console.warn('Could not open the microphone:', error);
      setMicProblem('failed');
      showNotice('Microphone unavailable', 'It may be in use elsewhere.');
    }
    return;
  }
  const track = stream.getAudioTracks()[0];
  if (generation !== micGeneration || !enabled() || !track) {
    for (const t of stream.getTracks()) t.stop();
    return;
  }
  mic = stream;
  if (micProblem !== undefined) {
    setMicProblem(undefined);
    hideNotice();
  }
  // Unplugged: open again (the default device) on the next press.
  track.addEventListener('ended', () => {
    if (mic === stream) closeMic();
  });
  void listDevices();
  return track;
}

/** The live microphone track, asking for the microphone if needed. */
function micTrack(): Promise<MediaStreamTrack | undefined> {
  const live = mic?.getAudioTracks()[0];
  if (live?.readyState === 'live') return Promise.resolve(live);
  if (!micOpening) {
    const opening = openMic().finally(() => {
      if (micOpening === opening) micOpening = undefined;
    });
    micOpening = opening;
  }
  return micOpening;
}

function closeMic(): void {
  micGeneration++;
  micOpening = undefined;
  clearTimeout(micIdleTimer);
  stopTest();
  if (!mic) return;
  for (const track of mic.getTracks()) track.stop();
  mic = undefined;
}

/** Closes the microphone once it hasn't been used for MIC_IDLE_MS. */
function scheduleMicIdle(): void {
  clearTimeout(micIdleTimer);
  micIdleTimer = setTimeout(() => {
    if (!talking && !testing) closeMic();
  }, MIC_IDLE_MS);
}

// --- Talking ------------------------------------------------------------

async function startSending(): Promise<void> {
  const generation = micGeneration;
  const track = await micTrack();
  if (!talking) return;
  if (!track) {
    // No microphone: nothing to send until the next press. (If it was
    // closed meanwhile, whoever closed it opens it again.)
    if (generation === micGeneration) stopTalking();
    return;
  }
  try {
    await engine?.setMicTrack(track);
  } catch (error) {
    console.warn('Could not send the microphone:', error);
  }
}

function press(holder: Holder): void {
  holders.add(holder);
  clearTimeout(releaseTimer);
  releaseTimer = undefined;
  if (talking) return;
  talking = true;
  renderButton();
  emit({ type: 'talking', talking: true });
  void startSending();
}

/** Lets go of holder; sending stops RELEASE_TAIL_MS after the last one. */
function release(holder: Holder): void {
  if (!holders.delete(holder) || holders.size > 0) return;
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(stopTalking, RELEASE_TAIL_MS);
}

/** Stops sending now. */
function stopTalking(): void {
  clearTimeout(releaseTimer);
  releaseTimer = undefined;
  holders.clear();
  heldCode = undefined;
  if (!talking) return;
  talking = false;
  renderButton();
  emit({ type: 'talking', talking: false });
  engine?.setMicTrack(null).catch((error) => {
    console.warn('Could not stop the microphone:', error);
  });
  scheduleMicIdle();
}

function isTalkKey(
  event: KeyboardEvent,
  settings: Readonly<Settings>
): boolean {
  const key = settings.voiceKey;
  return key !== 'off' && event.code === `Key${key.toUpperCase()}`;
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.code === heldCode) {
    // Repeats of the held key.
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if (!isTalkKey(event, getSettings()) || !canTalk()) return;
  if (event.ctrlKey || event.altKey || event.metaKey || anyModalOpen()) return;
  // preventDefault also cancels the keypress, so the engine sees nothing.
  event.preventDefault();
  event.stopImmediatePropagation();
  // Repeats after talking stopped by itself (e.g. the microphone was
  // refused) don't ask again; the next press does.
  if (event.repeat) return;
  heldCode = event.code;
  press('key');
}

function onKeyUp(event: KeyboardEvent): void {
  if (event.code !== heldCode) return;
  // The engine never saw the keydown.
  event.stopImmediatePropagation();
  heldCode = undefined;
  release('key');
}

window.addEventListener('keydown', onKey, { capture: true });
window.addEventListener('keypress', onKey, { capture: true });
window.addEventListener('keyup', onKeyUp, { capture: true });

function onKey(event: KeyboardEvent): void {
  if (event.type === 'keydown') onKeyDown(event);
  else if (event.code === heldCode) event.stopImmediatePropagation();
}

// A key held while the page loses focus never sends its keyup.
window.addEventListener('blur', () => {
  if (heldCode) {
    heldCode = undefined;
    release('key');
  }
});

// Touch: hold the button. It is outside the canvas, so the engine's touch
// listeners never see it; the pointer is captured so a finger sliding off
// the button keeps talking until it is lifted.
function renderButton(): void {
  button.hidden =
    !inGame ||
    !touchControls ||
    gameMenuOpen ||
    !enabled() ||
    !engine?.voiceAvailable;
  button.setAttribute('aria-pressed', String(talking));
}

button.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  if (touchPointer !== undefined || !canTalk()) return;
  touchPointer = event.pointerId;
  // Touch pointers are captured by the button anyway; this covers pens and
  // mice. It throws if the pointer is already gone.
  try {
    button.setPointerCapture(event.pointerId);
  } catch {}
  press('touch');
});

function onPointerEnd(event: PointerEvent): void {
  if (event.pointerId !== touchPointer) return;
  touchPointer = undefined;
  release('touch');
}

button.addEventListener('pointerup', onPointerEnd);
button.addEventListener('pointercancel', onPointerEnd);
button.addEventListener('lostpointercapture', onPointerEnd);
// A long press would open the context menu (Android) or select (iOS).
button.addEventListener('contextmenu', (event) => event.preventDefault());

// --- Playback -----------------------------------------------------------

function audioContext(): AudioContext {
  if (!audio) {
    audio = new AudioContext();
    master = audio.createGain();
    master.connect(audio.destination);
    applyVolume();
  }
  return audio;
}

/** Audio runs while lanes may play (in game) or the test shows a level. */
function audioWanted(): boolean {
  return enabled() && (inGame || testing);
}

function applyVolume(): void {
  if (!master || !audio) return;
  const settings = getSettings();
  master.gain.value = settings.voiceEnabled ? settings.voiceVolume / 100 : 0;
  // Without a user gesture yet resume() waits; the listener below retries.
  if (audioWanted()) void audio.resume();
  else void audio.suspend();
}

function applyLaneGain(lane: Lane): void {
  // A quiet lane carries no audio; before its event names the speaker
  // (it may come just after the first packets) it plays at 1.
  if (lane.gain)
    lane.gain.gain.value = lane.userid ? playerGain(lane.userid) : 1;
}

function dropLane(index: number): void {
  const lane = lanes[index];
  if (!lane) return;
  lane.source?.disconnect();
  lane.gain?.disconnect();
  if (lane.element) lane.element.srcObject = null;
  if (lane.userid) emit({ type: 'lane', lane: index, userid: 0 });
  lanes[index] = { userid: 0, active: false };
}

function setAdminMuted(userids: number[]): void {
  if (userids.join() === adminMuted.join()) return;
  adminMuted = userids;
  emit({ type: 'muted', userids });
}

function onVoiceTrack(
  index: number,
  track: MediaStreamTrack,
  receiver?: RTCRtpReceiver
): void {
  // A new connection: its lanes start quiet, and nobody is admin-muted
  // until its server says so (lane 0's track comes first, with the offer,
  // before the voice data channel can carry the list).
  dropLane(index);
  if (index === 0) setAdminMuted([]);
  const context = audioContext();
  const stream = new MediaStream([track]);
  const element = new Audio();
  element.muted = true;
  element.srcObject = stream;
  void element.play().catch(() => {});
  const source = context.createMediaStreamSource(stream);
  const gain = context.createGain();
  source.connect(gain).connect(master!);
  const lane: Lane = {
    userid: 0,
    active: false,
    receiver,
    element,
    source,
    gain,
  };
  lanes[index] = lane;
  applyLaneGain(lane);
  applyVolume();
  renderButton();
}

function onVoiceLane(index: number, userid: number): void {
  const lane = (lanes[index] ??= { userid: 0, active: false });
  lane.userid = userid;
  // The event comes with the speaker's first packet.
  lane.active = userid !== 0;
  lane.packetTime = lastPacketTime(lane);
  lane.packetSeen = lane.since = performance.now();
  applyLaneGain(lane);
  emit({ type: 'lane', lane: index, userid });
  watchActivity();
}

/**
 * The receiver's last packet time (`RTCRtpSynchronizationSource.timestamp`:
 * when its audio was last delivered to the track; epoch milliseconds in
 * Chrome, see packetAge).
 */
function lastPacketTime(lane: Lane): number | undefined {
  try {
    const sources = lane.receiver?.getSynchronizationSources?.() ?? [];
    return sources.reduce<number | undefined>(
      (latest, source) =>
        latest === undefined || source.timestamp > latest
          ? source.timestamp
          : latest,
      undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * While a lane has a speaker, notices when their packets stop and start
 * again (a `lane` event with `active`), so the indicators follow the voice
 * rather than the server's 500 ms quiet event.
 */
function watchActivity(): void {
  const wanted = lanes.some((lane) => lane?.userid && lane.receiver);
  if (!wanted) {
    clearInterval(activityTimer);
    activityTimer = undefined;
    return;
  }
  activityTimer ??= setInterval(checkActivity, ACTIVITY_POLL_MS);
}

/**
 * How long ago the lane's last packet came. The timestamp is on the epoch
 * clock (performance.timeOrigin + now) where browsers follow the spec; if
 * it isn't (far from it), the time since it last changed is used instead.
 */
function packetAge(lane: Lane, time: number, now: number): number {
  const age = performance.timeOrigin + now - time;
  if (age > -1_000 && age < 60_000) return Math.max(0, age);
  return now - (lane.packetSeen ?? now);
}

function checkActivity(): void {
  const now = performance.now();
  lanes.forEach((lane, index) => {
    if (!lane?.userid || !lane.receiver) return;
    // No packet delivered yet on this receiver: wait for the first.
    const time = lastPacketTime(lane);
    if (time === undefined) return;
    if (time !== lane.packetTime) {
      lane.packetTime = time;
      lane.packetSeen = now;
    }
    const silent =
      Math.min(packetAge(lane, time, now), now - (lane.since ?? now)) >=
      LANE_SILENT_MS;
    if (!silent && !lane.active) {
      lane.active = true;
      emit({ type: 'lane', lane: index, userid: lane.userid });
    } else if (silent && lane.active) {
      lane.active = false;
      emit({ type: 'lane', lane: index, userid: lane.userid, active: false });
    }
  });
  watchActivity();
}

// Audio can only start after a user gesture; the first key or tap in game
// resumes it (as the engine does with its own sound).
for (const type of ['keydown', 'pointerdown'] as const) {
  window.addEventListener(
    type,
    () => {
      if (audio?.state === 'suspended' && audioWanted()) {
        void audio.resume();
      }
    },
    { capture: true, passive: true }
  );
}

// --- Settings panel: microphones and the microphone test ----------------

/** Lists the microphones by name, once the browser shows the names. */
async function listDevices(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  let devices: MediaDeviceInfo[];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }
  const inputs = devices.filter(
    (device) =>
      device.kind === 'audioinput' &&
      device.deviceId !== '' &&
      device.deviceId !== 'default' &&
      device.deviceId !== 'communications'
  );
  // Without permission there are no names (and often no ids).
  if (!inputs.some((device) => device.label)) return;
  devicesListed = true;
  setDeviceOptions(
    'voiceInput',
    inputs.map((device, index) => ({
      value: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
    }))
  );
  renderTest();
}

navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  if (devicesListed) void listDevices();
});

const testBox = document.createElement('div');
testBox.className = 'settings-voice-test';
const testButton = document.createElement('button');
testButton.type = 'button';
testButton.className = 'action-button admin-secondary';
const meter = document.createElement('div');
meter.className = 'settings-voice-meter';
meter.setAttribute('role', 'meter');
meter.setAttribute('aria-label', 'Microphone level');
meter.setAttribute('aria-valuemin', '0');
meter.setAttribute('aria-valuemax', '100');
const level = document.createElement('div');
level.className = 'settings-voice-level';
meter.append(level);
const status = document.createElement('p');
status.className = 'settings-voice-status';
status.setAttribute('aria-live', 'polite');
testBox.append(testButton, meter, status);
settingsGroupFields('Voice')?.append(testBox);

let testAnalyser: AnalyserNode | undefined;
let testSource: MediaStreamAudioSourceNode | undefined;
let testFrame = 0;
let testTimer: ReturnType<typeof setTimeout> | undefined;

function statusText(): { text: string; error: boolean } {
  const settings = getSettings();
  if (!settings.voiceEnabled) {
    return {
      text: 'Voice chat is off: the microphone is never used and nobody is heard.',
      error: false,
    };
  }
  switch (micProblem) {
    case 'blocked':
      return { text: `Microphone blocked. ${BLOCKED_HELP}`, error: true };
    case 'insecure':
      return { text: INSECURE_HELP, error: true };
    case 'missing':
      return { text: 'No microphone found.', error: true };
    case 'failed':
      return {
        text: "Couldn't open the microphone. It may be in use elsewhere.",
        error: true,
      };
  }
  const how =
    settings.voiceKey === 'off'
      ? 'Pick a push-to-talk key under Keys to talk (touch: hold the microphone button).'
      : `Hold ${settings.voiceKey.toUpperCase()} to talk to your team (touch: hold the microphone button).`;
  return devicesListed
    ? { text: how, error: false }
    : {
        text: `${how} The microphones are listed once you allow the microphone.`,
        error: false,
      };
}

function renderTest(): void {
  testButton.textContent = testing ? 'Stop test' : 'Test microphone';
  testButton.disabled = !enabled();
  meter.hidden = !testing;
  const { text, error } = statusText();
  status.textContent = text;
  status.classList.toggle('error', error);
}

function drawLevel(): void {
  if (!testAnalyser) return;
  const samples = new Float32Array(testAnalyser.fftSize);
  testAnalyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / samples.length);
  // -70 dB (silence) to -10 dB (loud speech); the browser's noise
  // suppression and gain control apply, as for what is sent.
  const value = Math.max(
    0,
    Math.min(1, (20 * Math.log10(rms || 1e-7) + 70) / 60)
  );
  level.style.transform = `scaleX(${value.toFixed(3)})`;
  meter.setAttribute('aria-valuenow', String(Math.round(value * 100)));
  testFrame = requestAnimationFrame(drawLevel);
}

async function startTest(): Promise<void> {
  if (testing || !enabled()) return;
  testing = true;
  renderTest();
  // The click is a user gesture: audio may start.
  const context = audioContext();
  void context.resume();
  const track = await micTrack();
  if (!testing) return;
  if (!track) {
    stopTest();
    return;
  }
  testSource = context.createMediaStreamSource(new MediaStream([track]));
  testAnalyser = context.createAnalyser();
  testAnalyser.fftSize = 1024;
  // Not connected to the speakers: the test only shows the level.
  testSource.connect(testAnalyser);
  drawLevel();
  testTimer = setTimeout(stopTest, TEST_MS);
}

function stopTest(): void {
  if (!testing) return;
  testing = false;
  cancelAnimationFrame(testFrame);
  clearTimeout(testTimer);
  testSource?.disconnect();
  testSource = undefined;
  testAnalyser = undefined;
  level.style.transform = 'scaleX(0)';
  renderTest();
  applyVolume();
  scheduleMicIdle();
}

testButton.addEventListener('click', () => {
  if (testing) stopTest();
  else void startTest();
});

onSettingsPanel((open) => {
  if (open) {
    renderTest();
    void listDevices();
  } else {
    stopTest();
  }
});

renderTest();

onSettingsChange((settings, changed) => {
  if (changed.includes('voiceEnabled') && !settings.voiceEnabled) {
    // Off: stop sending, close the microphone, play nothing.
    stopTalking();
    closeMic();
  }
  if (changed.includes('voiceInput') && mic) {
    const wasTesting = testing;
    closeMic();
    if (talking) void startSending();
    if (wasTesting) void startTest();
  }
  if (changed.includes('voiceKey') && heldCode) {
    heldCode = undefined;
    release('key');
  }
  applyVolume();
  renderButton();
  renderTest();
});

onHudEvent((event) => {
  if (event.type !== 'menu') return;
  gameMenuOpen = event.payload.visible;
  renderButton();
});

// --- Engine -------------------------------------------------------------

/**
 * Takes the voice lanes of engine's connections (call right after creating
 * the engine, before connecting: the lanes' tracks arrive with the offer).
 */
export function initVoice(target: Xash3DWebRTC): void {
  engine = target;
  target.onVoiceTrack = onVoiceTrack;
  target.onVoiceLane = onVoiceLane;
  target.onVoiceMuted = setAdminMuted;
}

/**
 * In game (after engine.main()): the talk key and, with touch controls,
 * the microphone button talk; lanes play.
 */
export function attachVoice(touch: boolean): void {
  if (!engine) return;
  inGame = true;
  touchControls = touch;
  gameMenuOpen = false;
  // K is +voicerecord in the game's config; the page has the key now.
  engine.Cmd_ExecuteString('unbind k');
  applyVolume();
  renderButton();
}

/** Stops talking and playing (connection lost). */
export function detachVoice(): void {
  inGame = false;
  stopTalking();
  closeMic();
  hideNotice();
  for (let index = 0; index < lanes.length; index++) dropLane(index);
  setAdminMuted([]);
  void audio?.suspend();
  renderButton();
}

// --- For the speaking list and mutes (voice-hud.ts) ---------------------

/**
 * Calls listener on lane changes, when the local player talks and when the
 * admin-muted list changes.
 */
export function onVoiceEvent(
  listener: (event: VoiceEvent) => void
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Sets each player's playback gain (0 mutes), by engine userid. */
export function setPlayerGain(gain: (userid: number) => number): void {
  playerGain = gain;
  for (const lane of lanes) if (lane) applyLaneGain(lane);
}

/** Whether the local player is sending (key or button held, or the tail). */
export function isTalking(): boolean {
  return talking;
}

/** Whether the game is played with touch controls (attachVoice). */
export function usesTouchControls(): boolean {
  return inGame && touchControls;
}

/** Whether the current connection's server offers voice. */
export function voiceOffered(): boolean {
  return !!engine?.voiceAvailable;
}

/** The userids the admin has muted on this connection's server. */
export function adminMutedUserids(): readonly number[] {
  return adminMuted;
}

/**
 * The engine userid heard on each lane (0: quiet). activeOnly: only lanes
 * whose packets are arriving now (the speaking indicators).
 */
export function laneSpeakers(activeOnly = false): number[] {
  return lanes.map((lane) =>
    lane && (!activeOnly || lane.active) ? lane.userid : 0
  );
}
