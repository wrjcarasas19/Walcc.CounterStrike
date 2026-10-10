import {
  DEFAULT_ANNOUNCER_OPTIONS,
  SOUND_NAMES,
  shouldReplace,
  type AnnouncerOptions,
  type SoundName,
} from './announcer-rules';

// Announcer sounds (C.2): First Blood, Headshot, multi-kills... on top of the
// HUD's toasts. The files (public/sounds, C.1) are fetched once the game has
// started (never on the login page), decoded once into Web Audio buffers and
// played through one GainNode, one sound at a time (announcer-rules.ts has
// the priorities). Browsers start an AudioContext suspended until a user
// gesture, so it's resumed on the first key, click or tap, like the engine's
// own audio. Sounds asked for before that are dropped, not queued.
//
// Every play, drop and load is logged with console.debug ("announcer: ..."),
// which the headless checks read (plans/new-features-1006-tools).

const SOUNDS_URL = '/sounds/';
const GESTURES = ['keydown', 'pointerdown', 'touchend', 'mousedown'] as const;

let context: AudioContext | undefined;
let gain: GainNode | undefined;
const buffers = new Map<SoundName, AudioBuffer>();
let playing: { name: SoundName; source: AudioBufferSourceNode } | undefined;
let options: AnnouncerOptions = { ...DEFAULT_ANNOUNCER_OPTIONS };
let loading: Promise<void> | undefined;
// startAnnouncer was called (the game has started). At volume 0 nothing is
// created or fetched until the volume goes up.
let started = false;

function log(...args: unknown[]): void {
  console.debug('announcer:', ...args);
}

/** Opus in WebM where the browser plays it, MP3 otherwise (older Safari). */
function preferredExtension(): '.webm' | '.mp3' {
  const probe = document.createElement('audio');
  return probe.canPlayType('audio/webm; codecs="opus"') ? '.webm' : '.mp3';
}

async function decode(
  ctx: AudioContext,
  name: SoundName,
  ext: string
): Promise<AudioBuffer> {
  const response = await fetch(`${SOUNDS_URL}${name}${ext}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return ctx.decodeAudioData(await response.arrayBuffer());
}

async function load(ctx: AudioContext): Promise<void> {
  const ext = preferredExtension();
  let loaded = 0;
  await Promise.all(
    SOUND_NAMES.map(async (name) => {
      try {
        buffers.set(name, await decode(ctx, name, ext));
        loaded++;
        return;
      } catch (error) {
        if (ext === '.mp3') {
          log(`${name} failed to load`, error);
          return;
        }
        // canPlayType can say yes to WebM that decodeAudioData refuses.
        log(`${name}${ext} failed, trying .mp3`, error);
      }
      try {
        buffers.set(name, await decode(ctx, name, '.mp3'));
        loaded++;
      } catch (error) {
        log(`${name} failed to load`, error);
      }
    })
  );
  log(`loaded ${loaded}/${SOUND_NAMES.length} sounds (${ext})`);
}

function resume(): void {
  if (!context) return;
  if (context.state === 'running') {
    removeGestureListeners();
    return;
  }
  void context.resume().then(
    () => {
      if (context?.state !== 'running') return;
      log('audio running');
      removeGestureListeners();
    },
    () => {}
  );
}

function removeGestureListeners(): void {
  for (const type of GESTURES) {
    window.removeEventListener(type, resume, { capture: true });
  }
}

/**
 * Creates the AudioContext and starts loading the sounds. Call once the game
 * has started (after Connect). Safe to call again. At volume 0 it waits
 * until setAnnouncerOptions turns the volume up.
 */
export function startAnnouncer(): void {
  started = true;
  if (context) return;
  if (options.volume <= 0) {
    log('off (volume 0), sounds not loaded');
    return;
  }
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) {
    log('no Web Audio');
    return;
  }
  context = new Ctor();
  log(`audio ${context.state}`);
  gain = context.createGain();
  gain.gain.value = options.volume / 100;
  gain.connect(context.destination);
  for (const type of GESTURES) {
    window.addEventListener(type, resume, { capture: true, passive: true });
  }
  resume();
  loading = load(context);
}

/** Resolves when the sounds have been loaded (or failed to); for checks. */
export function announcerReady(): Promise<void> {
  return loading ?? Promise.resolve();
}

/**
 * The hook for the settings (C.3): sets the volume (0-100 %, 0 = off) and
 * which sounds play. Unset fields keep their value. Turning the volume up
 * from 0 after the game started loads the sounds then.
 */
export function setAnnouncerOptions(next: Partial<AnnouncerOptions>): void {
  options = { ...options, ...next };
  if (gain) gain.gain.value = Math.max(0, Math.min(100, options.volume)) / 100;
  if (options.volume <= 0) stopAnnouncer();
  else if (started && !context) startAnnouncer();
}

export function getAnnouncerOptions(): Readonly<AnnouncerOptions> {
  return options;
}

/** Stops the sound that is playing, if any. */
export function stopAnnouncer(): void {
  if (!playing) return;
  const { source } = playing;
  playing = undefined;
  try {
    source.stop();
  } catch {}
}

/**
 * Plays name, unless a sound with a higher priority is playing; a sound with
 * the same or a lower priority is stopped first.
 */
export function announce(name: SoundName): void {
  if (!context || !gain) return;
  if (options.volume <= 0) {
    log(`${name} dropped (volume 0)`);
    return;
  }
  if (context.state !== 'running') {
    log(`${name} dropped (audio ${context.state})`);
    return;
  }
  const buffer = buffers.get(name);
  if (!buffer) {
    log(`${name} dropped (not loaded)`);
    return;
  }
  if (!shouldReplace(playing?.name, name)) {
    log(`${name} dropped (${playing!.name} playing)`);
    return;
  }
  stopAnnouncer();
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(gain);
  const entry = { name, source };
  source.onended = () => {
    if (playing === entry) playing = undefined;
  };
  playing = entry;
  source.start();
  log(`play ${name}`);
}
