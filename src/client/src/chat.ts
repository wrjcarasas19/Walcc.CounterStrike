import type { Xash3D } from 'xash3d-fwgs';
import { isHudActive, isMenuOpen, onHudEvent } from './hud';
import { CHAT_MAX_LENGTH, checkChatMessage } from './message-text';
import { addOverlay, anyModalOpen } from './modal';

// HTML chat input that replaces the engine's messagemode prompt while the
// HTML HUD is on. Y opens "Say", U opens "Say (team)"; with the HTML HUD off
// (an older cs16-client with no bridge; 0.0.9+ locks hud_html to 1) the keys
// go to the engine as before.
//
// Keys: the capture listeners below are registered at module load, after
// modal.ts's (imported above) and before the engine's (created later) and
// the radio wheel's key watcher (main.ts imports this module first). Menus
// therefore keep their keys, and an open input keeps every key from the game.

type Mode = 'say' | 'team';

const LABELS: Record<Mode, string> = { say: 'Say', team: 'Say (team)' };
const OPEN_KEYS: Partial<Record<string, Mode>> = { KeyY: 'say', KeyU: 'team' };
const COMMANDS: Record<Mode, string> = { say: 'say', team: 'say_team' };
/** Sent messages kept for ↑ / ↓. */
const HISTORY_LENGTH = 20;
/**
 * Shortest time between two sent messages. Host_Say silently drops a message
 * sent less than 0.66 s after the previous one, so the input says so instead.
 */
const SEND_INTERVAL_MS = 1_000;

const hud = document.getElementById('hud')!;
const form = document.getElementById('hud-chat-input') as HTMLFormElement;
const label = document.getElementById('hud-chat-input-label')!;
const modeButton = document.getElementById(
  'hud-chat-input-mode'
) as HTMLButtonElement;
const field = document.getElementById(
  'hud-chat-input-field'
) as HTMLInputElement;
const count = document.getElementById('hud-chat-input-count')!;
const error = document.getElementById('hud-chat-input-error')!;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const chatButton = document.getElementById('chat-button') as HTMLButtonElement;

field.maxLength = CHAT_MAX_LENGTH;

let engine: Xash3D | undefined;
let mode: Mode = 'say';
/** Touch controls are on (attachChat): chat button, Say / Team button. */
let touchControls = false;

// Sent messages, oldest first, for this page only: kept across map changes
// and reconnects (detachChat / attachChat), never saved.
const history: string[] = [];
/** The entry shown in the field; history.length means the draft. */
let historyIndex = 0;
/** What was typed before ↑ was first pressed. */
let draft = '';
/** performance.now() of the last sent message. */
let lastSent = -Infinity;
let waitTimer: ReturnType<typeof setTimeout> | undefined;

/** True while the chat input is open. */
export function isChatOpen(): boolean {
  return !form.hidden;
}

function canOpen(): boolean {
  return (
    engine !== undefined && isHudActive() && !isMenuOpen() && !anyModalOpen()
  );
}

function setMode(next: Mode): void {
  mode = next;
  label.textContent = LABELS[mode];
  modeButton.textContent = LABELS[mode];
  form.classList.toggle('team', mode === 'team');
}

/** The touch chat button shows while Y would open the input. */
function refreshChatButton(): void {
  const hide =
    !touchControls ||
    engine === undefined ||
    !isHudActive() ||
    isMenuOpen() ||
    isChatOpen();
  if (chatButton.hidden !== hide) chatButton.hidden = hide;
}

/**
 * Keeps the input above the on-screen keyboard while it is open. The
 * keyboard shrinks the visual viewport (iOS Safari, and Android Chrome since
 * 108) rather than the page, so the HUD's bottom edge can be under it;
 * --chat-keyboard is how much of the HUD it covers (0 with no keyboard).
 */
function placeAboveKeyboard(): void {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const covered = Math.max(
    0,
    Math.round(
      hud.getBoundingClientRect().bottom -
        (viewport.offsetTop + viewport.height)
    )
  );
  hud.style.setProperty('--chat-keyboard', `${covered}px`);
  hud.classList.toggle('chat-keyboard', covered > 0);
}

function watchKeyboard(watch: boolean): void {
  const viewport = window.visualViewport;
  if (!viewport) return;
  if (watch) {
    viewport.addEventListener('resize', placeAboveKeyboard);
    viewport.addEventListener('scroll', placeAboveKeyboard);
    placeAboveKeyboard();
    return;
  }
  viewport.removeEventListener('resize', placeAboveKeyboard);
  viewport.removeEventListener('scroll', placeAboveKeyboard);
  hud.style.removeProperty('--chat-keyboard');
  hud.classList.remove('chat-keyboard');
}

/** Updates the counter and the error line for the text in the field. */
function refresh(): void {
  const length = field.value.length;
  count.textContent = length > 0 ? `${length}/${CHAT_MAX_LENGTH}` : '';
  count.classList.toggle('limit', length >= CHAT_MAX_LENGTH);
  const result = checkChatMessage(field.value);
  // An empty field is not an error: Enter just closes the input.
  error.textContent =
    result.ok || field.value.trim() === '' ? '' : result.error;
}

function setText(text: string): void {
  clearTimeout(waitTimer);
  field.value = text;
  field.setSelectionRange(text.length, text.length);
  refresh();
}

function open(next: Mode): void {
  if (isChatOpen() || !canOpen()) return;
  setMode(next);
  historyIndex = history.length;
  draft = '';
  setText('');
  form.hidden = false;
  hud.classList.add('chat-open');
  refreshChatButton();
  document.exitPointerLock?.();
  // preventScroll: iOS would pan the page to the field; watchKeyboard moves
  // the field instead.
  field.focus({ preventScroll: true });
  watchKeyboard(true);
}

/**
 * relock takes the pointer lock back for the game; pass true only when
 * closing from a key gesture (Enter, Esc), as browsers refuse it otherwise.
 * Never with touch controls, which play without it. Blurring the field hides
 * the on-screen keyboard, and touches go to the game again.
 */
function close(relock: boolean): void {
  if (!isChatOpen()) return;
  form.hidden = true;
  hud.classList.remove('chat-open');
  watchKeyboard(false);
  setText('');
  const focused = document.activeElement as HTMLElement | null;
  if (focused && form.contains(focused)) focused.blur();
  refreshChatButton();
  if (relock && engine && !touchControls) {
    try {
      void Promise.resolve(canvas.requestPointerLock()).catch(() => {});
    } catch {}
  }
}

/** ↑ (step -1) or ↓ (step 1) through the sent messages. */
function browseHistory(step: -1 | 1): void {
  const next = historyIndex + step;
  if (next < 0 || next > history.length) return;
  if (historyIndex === history.length) draft = field.value;
  historyIndex = next;
  setText(next === history.length ? draft : history[next]);
}

function remember(text: string): void {
  if (history[history.length - 1] === text) return;
  history.push(text);
  if (history.length > HISTORY_LENGTH) history.shift();
}

/**
 * Runs `say "<text>"` (or say_team). How the text reaches the other players
 * (Xash3D FWGS common/cmd.c; ReGameDLL_CS dlls/client.cpp Host_Say, which
 * matches the stock game):
 * - Engine.Cmd_ExecuteString calls the engine's Cmd_ExecuteString directly
 *   (no command buffer, so `;` and newlines don't split it). `say` is no
 *   client command, so Cmd_ForwardToServer sends `say ` plus Cmd_Args(): the
 *   raw rest of the line after the first word, not the parsed words, so
 *   runs of spaces, `?` and `:` are kept as typed.
 * - The server runs it as a client command, and Host_Say takes CMD_ARGS()
 *   (raw too); if it starts with `"` it drops that and the last character.
 * Quoted is what the engine's own messagemode sends (`%s "%s"`, console.c),
 * so the server and AMX Mod X plugins see the usual form, and the text is
 * one word whatever it starts with (unquoted, a text starting with `//`
 * would be dropped by the tokenizer, one starting with `"` would lose its
 * last character). checkChatMessage refuses `"`, so the quotes always pair.
 * Host_Say cuts the text at 125 bytes minus the length of its format name
 * (108 for a living player's say, as few as 104 when dead) and ignores a
 * message sent less than 0.66 s after the previous one.
 */
function sendChat(text: string): void {
  engine?.Cmd_ExecuteString(`${COMMANDS[mode]} "${text}"`);
}

/** Says why Enter did nothing, until the next message can be sent. */
function showWait(ms: number): void {
  error.textContent = 'One message per second. Press Enter again.';
  clearTimeout(waitTimer);
  waitTimer = setTimeout(refresh, ms);
}

/** Enter (or the keyboard's send button): sends the text, then closes. */
function submit(): void {
  if (field.value.trim() !== '') {
    const result = checkChatMessage(field.value);
    if (!result.ok) {
      refresh();
      return;
    }
    const wait = lastSent + SEND_INTERVAL_MS - performance.now();
    if (wait > 0) {
      showWait(wait);
      return;
    }
    sendChat(result.text);
    lastSent = performance.now();
    remember(result.text);
  }
  close(true);
}

function onKey(event: KeyboardEvent): void {
  if (isChatOpen()) {
    // No preventDefault for other keys, so they type into the field.
    event.stopImmediatePropagation();
    if (event.type !== 'keydown' || event.isComposing) return;
    if (event.code === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    } else if (event.key === 'Tab') {
      // Keep the focus in the field. The form's only other control, the
      // Say / Team button, is shown with touch controls only and is tapped.
      event.preventDefault();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      // preventDefault keeps the caret from jumping to the start / end.
      event.preventDefault();
      browseHistory(event.key === 'ArrowUp' ? -1 : 1);
    }
    return;
  }
  if (event.type !== 'keydown' || event.repeat) return;
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  const next = OPEN_KEYS[event.code];
  if (!next || !canOpen()) return;
  // preventDefault also cancels the keypress, so the letter isn't typed into
  // the field that gets the focus.
  event.preventDefault();
  event.stopImmediatePropagation();
  open(next);
}

window.addEventListener('keydown', onKey, { capture: true });
window.addEventListener('keypress', onKey, { capture: true });

field.addEventListener('input', (event) => {
  // maxlength already cuts typed and pasted text; this only covers input
  // methods that get past it (wait for the end of an IME composition).
  if (
    !(event as InputEvent).isComposing &&
    field.value.length > CHAT_MAX_LENGTH
  ) {
    setText(field.value.slice(0, CHAT_MAX_LENGTH));
    return;
  }
  refresh();
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  submit();
});

// Say / Team button (touch controls). Cancelling pointerdown and mousedown
// keeps the focus, and so the on-screen keyboard, on the field; click still
// fires.
modeButton.addEventListener('pointerdown', (event) => event.preventDefault());
modeButton.addEventListener('mousedown', (event) => event.preventDefault());
modeButton.addEventListener('click', () => {
  setMode(mode === 'say' ? 'team' : 'say');
  if (document.activeElement !== field) field.focus({ preventScroll: true });
});

// Touch chat button. It is outside the canvas, so the engine's touch
// listeners (on the canvas) never see the tap, and it is hidden while the
// input is open, so the pointerdown below never sees it either. Cancelling
// pointerdown keeps the focus off the button; opening from click (a user
// gesture) lets the focused field bring up the on-screen keyboard on iOS.
chatButton.addEventListener('pointerdown', (event) => event.preventDefault());
chatButton.addEventListener('click', () => open('say'));

// A click elsewhere (the game takes the pointer lock on a canvas click)
// closes the input, so no keys stay kept from the game.
window.addEventListener(
  'pointerdown',
  (event) => {
    if (isChatOpen() && !form.contains(event.target as Node)) close(false);
  },
  { capture: true }
);

addOverlay({ isOpen: isChatOpen, close: () => close(false) });

onHudEvent((event) => {
  if (event.type === 'reset') close(false);
  else if (event.type === 'menu' && event.payload.visible) close(false);
  // The first event also means the HTML HUD is now in use.
  refreshChatButton();
});

/**
 * Lets Y / U open the chat input for a running game (after engine.main()).
 * touch: touch controls are on, so the chat button and the Say / Team button
 * are shown and closing never takes the pointer lock.
 */
export function attachChat(
  target: Xash3D,
  { touch }: { touch: boolean }
): void {
  detachChat();
  engine = target;
  touchControls = touch;
  form.classList.toggle('touch', touch);
  modeButton.hidden = !touch;
  refreshChatButton();
}

/** Closes the chat input and disables it (connection lost). */
export function detachChat(): void {
  close(false);
  engine = undefined;
  refreshChatButton();
}
