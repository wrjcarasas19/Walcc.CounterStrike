import {
  hasPassword,
  isBusy,
  sendAction,
  setStatus,
  type AdminTab,
} from './core';
import type { AdminAction } from './actions';
import {
  MESSAGE_COLORS,
  MESSAGE_MAX_LENGTH,
  checkMessage,
  type MessageColor,
} from '../message-text';

// Server messages: sends the typed text to every player with AMX Mod X's
// adminchat commands, through a server alias (see message-text.ts). No HUD
// bridge event shows chat or HUD text, so this tab can't confirm a message
// and only says "Sent".
//
// The engine's own `say` isn't offered: it only prints a console line at
// the top left with every word in quotes, and AMX Mod X is part of the
// image, so it would only be a worse copy of Chat.

/** Where a message is shown, and the action that shows it there. */
type MessageTarget = {
  id: string;
  label: string;
  /** True when the colour select applies. */
  colored: boolean;
  /** Gets text that passed checkMessage. */
  action: (text: string, color: MessageColor) => AdminAction;
};

// With more than one target, a choice is shown.
const TARGETS: readonly MessageTarget[] = [
  {
    id: 'chat',
    label: 'Chat',
    colored: false,
    action: (text) => ({ action: 'say', text }),
  },
  {
    id: 'center',
    label: 'Center of screen',
    colored: true,
    action: (text, color) => ({ action: 'csay', text, color }),
  },
];
const DEFAULT_COLOR: MessageColor = 'yellow';

const panel = document.createElement('div');
panel.className = 'admin-tab-body admin-message';

const field = document.createElement('div');
field.className = 'field';
const label = document.createElement('label');
label.className = 'field-label';
label.htmlFor = 'admin-message-text';
label.textContent = 'Message to all players';
const input = document.createElement('input');
input.type = 'text';
input.id = label.htmlFor;
input.className = 'field-input';
input.autocomplete = 'off';
input.spellcheck = true;
// No maxLength: the browser would cut pasted text silently. Too long text
// is reported in the hint instead.
input.placeholder = 'Server restarts in 5 minutes';
const hint = document.createElement('span');
hint.className = 'admin-cvar-hint';
hint.id = `${input.id}-hint`;
hint.setAttribute('aria-live', 'polite');
input.setAttribute('aria-describedby', hint.id);
field.append(label, input, hint);

const targetGroup = document.createElement('div');
targetGroup.className = 'admin-maps';
targetGroup.setAttribute('role', 'radiogroup');
targetGroup.setAttribute('aria-label', 'Show the message in');
for (const [i, target] of TARGETS.entries()) {
  const option = document.createElement('label');
  option.className = 'admin-map';
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'admin-message-target';
  radio.value = target.id;
  radio.checked = i === 0;
  const text = document.createElement('span');
  text.textContent = target.label;
  option.append(radio, text);
  targetGroup.append(option);
}
targetGroup.addEventListener('change', () => refresh());

const colorField = document.createElement('div');
colorField.className = 'field';
const colorLabel = document.createElement('label');
colorLabel.className = 'field-label';
colorLabel.htmlFor = 'admin-message-color';
colorLabel.textContent = 'Colour (center only)';
const colorInput = document.createElement('select');
colorInput.id = colorLabel.htmlFor;
colorInput.className = 'field-input';
for (const color of MESSAGE_COLORS) {
  const text = color.charAt(0).toUpperCase() + color.slice(1);
  colorInput.append(new Option(text, color, false, color === DEFAULT_COLOR));
}
colorField.append(colorLabel, colorInput);

const note = document.createElement('p');
note.className = 'admin-note';
note.textContent =
  'Chat shows "(ALL) <server name> : message" in the chat box. Center ' +
  'shows "<server name> : message" in the middle of the screen for 6 ' +
  `seconds. Not allowed: " $ % ' , ; \\ ^ { } and //. Up to ` +
  `${MESSAGE_MAX_LENGTH} characters.`;

const submit = document.createElement('button');
submit.className = 'action-button';
submit.type = 'submit';
submit.disabled = true;
submit.textContent = 'Send message';

panel.append(field);
if (TARGETS.length > 1) panel.append(targetGroup);
if (TARGETS.some((target) => target.colored)) panel.append(colorField);
panel.append(note, submit);

// The last message sent this session, shown in the hint.
let lastSent: string | undefined;

input.addEventListener('input', () => {
  renderHint();
  refresh();
});
renderHint();

function selectedTarget(): MessageTarget {
  const id =
    targetGroup.querySelector<HTMLInputElement>('input:checked')?.value;
  return TARGETS.find((target) => target.id === id) ?? TARGETS[0];
}

function renderHint(): void {
  const empty = input.value.trim() === '';
  const checked = checkMessage(input.value);
  const invalid = !empty && !checked.ok;
  input.setAttribute('aria-invalid', String(invalid));
  hint.classList.toggle('error', invalid);
  if (!checked.ok && !empty) {
    hint.textContent = checked.error;
    return;
  }
  const length = empty ? 0 : Array.from(input.value.trim()).length;
  const parts = [`${length}/${MESSAGE_MAX_LENGTH}`];
  if (lastSent !== undefined) parts.push(`Sent: ${lastSent}`);
  hint.textContent = parts.join(' · ');
}

function selectedColor(): MessageColor {
  return (
    MESSAGE_COLORS.find((color) => color === colorInput.value) ?? DEFAULT_COLOR
  );
}

function refresh(): void {
  submit.disabled = isBusy() || !hasPassword() || !checkMessage(input.value).ok;
  colorInput.disabled = !selectedTarget().colored;
}

function send(): void {
  if (isBusy()) return;
  const checked = checkMessage(input.value);
  if (!checked.ok) {
    setStatus(checked.error, true);
    input.focus();
    return;
  }
  const target = selectedTarget();
  // Over rcon the alias commands (message-text.ts) go in one go, so the
  // packets usually travel together: they go over an unordered channel, and
  // a lost or late definition only loses the message.
  if (!sendAction(target.action(checked.text, selectedColor()))) return;
  lastSent = checked.text;
  input.value = '';
  renderHint();
  refresh();
  // Nothing on the HUD confirms a console message, so this can't say "Done".
  setStatus("Sent. If players don't see it, check the password.");
}

export const messagesTab: AdminTab = {
  id: 'message',
  label: 'Message',
  panel,
  submit: send,
  refresh,
  focusTarget: () => input,
};
