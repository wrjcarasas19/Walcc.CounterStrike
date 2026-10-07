import { copyLink } from '../invite';
import { recheckNameStatus } from '../name-status';
import { currentPlayerName, setPlayerNameField } from '../player';
import {
  claimName,
  fetchMyName,
  looksLikeRecoveryCode,
  namesErrorText,
  RECOVERY_CODE_EXAMPLE,
  releaseDevice,
  releaseName,
  signIn,
  type NamesAction,
  type NamesError,
} from './api';

// "Your name" section of the settings panel (F3), under the invite link:
// claim the current nickname (plan E.5), see the recovery code once, sign
// in with name + code, release this browser or the name. Hidden on a server
// without claimed names (/names/me answers 404). The server does all the
// matching; this only shows what it says.
//
// The game connection reads the cookie when it opens (sfu.go), so a claim
// or sign-in made in game only counts from the next join: until then the
// server treats the player as a guest and may rename them. In game the
// section offers "Rejoin now" (main.ts drops and reopens the connection).

type FormMode = 'none' | 'signin' | 'releaseName' | 'releaseDevice';

const section = document.createElement('section');
section.className = 'settings-group names';
section.setAttribute('aria-labelledby', 'names-title');
section.hidden = true;

const title = document.createElement('h2');
title.id = 'names-title';
title.className = 'settings-group-title';
title.textContent = 'Your name';

const intro = document.createElement('p');
intro.className = 'invite-hint names-intro';

// The recovery code, shown once after a claim.
const codeBox = document.createElement('div');
codeBox.className = 'names-code';
codeBox.hidden = true;
const codeLabel = document.createElement('label');
codeLabel.className = 'field-label';
codeLabel.htmlFor = 'names-code-value';
const codeRow = document.createElement('div');
codeRow.className = 'invite-row';
const codeValue = document.createElement('input');
codeValue.id = 'names-code-value';
codeValue.className = 'field-input invite-link names-code-value';
codeValue.type = 'text';
codeValue.readOnly = true;
codeValue.spellcheck = false;
codeValue.addEventListener('focus', () => codeValue.select());
const copyButton = button('Copy code', 'invite-copy');
codeRow.append(codeValue, copyButton);
const codeHint = document.createElement('p');
codeHint.className = 'invite-hint names-warning';
codeHint.textContent =
  'Shown only this once. Save it somewhere safe (a password manager, a ' +
  'note): it signs in your other browsers, or this one after its cookies ' +
  'are cleared, and releases the name. Anyone who has it can use the name.';
const savedButton = button('I saved it', 'names-saved');
codeBox.append(codeLabel, codeRow, codeHint, savedButton);

// Buttons of the current state.
const actions = document.createElement('div');
actions.className = 'names-actions';
const claimButton = button('Claim', 'names-claim');
const signInButton = button('Sign in with a recovery code', 'names-signin');
const releaseOtherButton = button('Release a name', 'names-release-other');
const releaseDeviceButton = button(
  'Release this device',
  'names-release-device'
);
const releaseNameButton = button('Release the name', 'names-release-name');
const rejoinButton = button('Rejoin now', 'names-rejoin');
actions.append(
  claimButton,
  signInButton,
  releaseOtherButton,
  releaseDeviceButton,
  releaseNameButton,
  rejoinButton
);

// Sign in / release forms.
const form = document.createElement('form');
form.className = 'names-form';
form.hidden = true;
form.noValidate = true;
const formText = document.createElement('p');
formText.className = 'invite-hint names-form-text';
const nameField = field('names-name', 'Claimed name', 'text');
nameField.input.setAttribute('autocomplete', 'nickname');
const codeField = field('names-code', 'Recovery code', 'text');
codeField.input.autocomplete = 'off';
codeField.input.placeholder = RECOVERY_CODE_EXAMPLE;
codeField.input.spellcheck = false;
codeField.input.autocapitalize = 'characters';
const formButtons = document.createElement('div');
formButtons.className = 'names-actions';
const submitButton = button('Sign in', 'names-submit');
submitButton.type = 'submit';
const cancelButton = button('Cancel', 'names-cancel');
formButtons.append(submitButton, cancelButton);
form.append(formText, nameField.el, codeField.el, formButtons);

const status = document.createElement('div');
status.className = 'progress-status names-status';
status.setAttribute('role', 'status');

section.append(title, intro, codeBox, actions, form, status);

let available: boolean | undefined;
/** This browser's claimed name, '' for none. */
let mine = '';
let shownCode: { name: string; code: string } | undefined;
let mode: FormMode = 'none';
let busy = false;
let message = { text: '', error: false };
// A claim or sign-in made during this game connection (see the top).
let needsRejoin = false;
let rejoin: ((name: string) => void) | undefined;
let loading: Promise<void> | undefined;

function button(text: string, className: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `action-button admin-secondary names-button ${className}`;
  el.textContent = text;
  return el;
}

function field(id: string, label: string, type: string) {
  const el = document.createElement('div');
  el.className = 'field names-field';
  const labelEl = document.createElement('label');
  labelEl.className = 'field-label';
  labelEl.htmlFor = id;
  labelEl.textContent = label;
  const input = document.createElement('input');
  input.id = id;
  input.className = 'field-input';
  input.type = type;
  el.append(labelEl, input);
  return { el, input };
}

/** The nickname the player joins (or joined) with; '' if there is none. */
function nickname(): string {
  return currentPlayerName();
}

function setMessage(text: string, error = false): void {
  message = { text, error };
}

function render(): void {
  section.hidden = available !== true;
  const nick = nickname();
  const showCode = shownCode !== undefined;

  let text: string;
  if (mine) {
    text = `This browser has the name “${mine}” ✓. Only browsers signed in to it can play and score under it on this server.`;
    if (nick && nick.toLowerCase() !== mine.toLowerCase()) {
      text += ` Your nickname is “${nick}”: join as “${mine}” to use it.`;
    }
  } else {
    text =
      'Claim your nickname so nobody else can play or score under it on ' +
      'this server. No account or email: you get a recovery code instead.';
  }
  intro.textContent = text;

  codeBox.hidden = !showCode;
  if (shownCode) {
    codeLabel.textContent = `Recovery code for “${shownCode.name}”`;
    codeValue.value = shownCode.code;
  }

  actions.hidden = showCode || mode !== 'none';
  claimButton.hidden = mine !== '';
  claimButton.textContent = nick ? `Claim “${nick}”` : 'Claim your nickname';
  claimButton.disabled = busy || !nick;
  claimButton.title = nick ? '' : 'Type a nickname first';
  signInButton.hidden = mine !== '';
  releaseOtherButton.hidden = mine !== '';
  releaseDeviceButton.hidden = mine === '';
  releaseNameButton.hidden = mine === '';
  rejoinButton.hidden = !(needsRejoin && rejoin && mine);
  for (const el of [signInButton, releaseOtherButton, releaseDeviceButton]) {
    el.disabled = busy;
  }
  releaseNameButton.disabled = busy;
  rejoinButton.disabled = busy;

  form.hidden = showCode || mode === 'none';
  nameField.el.hidden =
    mode === 'releaseDevice' || (mode === 'releaseName' && mine !== '');
  codeField.el.hidden = mode === 'releaseDevice';
  submitButton.classList.toggle('names-danger', mode !== 'signin');
  submitButton.textContent =
    mode === 'signin'
      ? 'Sign in'
      : mode === 'releaseDevice'
        ? 'Release this device'
        : 'Release the name';
  formText.textContent =
    mode === 'signin'
      ? 'Sign this browser in to a name you claimed on another browser.'
      : mode === 'releaseDevice'
        ? `This browser will no longer have “${mine}”. The claim stays: the recovery code signs it in again.`
        : `Releasing ${mine ? `“${mine}”` : 'a name'} signs every browser out of it and lets anyone claim it. Its leaderboard row is kept.`;
  submitButton.disabled = busy;
  cancelButton.disabled = busy;
  nameField.input.disabled = busy;
  codeField.input.disabled = busy;

  status.textContent = message.text;
  status.classList.toggle('error', message.error);
}

function openForm(next: FormMode): void {
  mode = next;
  setMessage('');
  if (next === 'signin' || next === 'releaseName') {
    if (!nameField.input.value) nameField.input.value = nickname();
    codeField.input.value = '';
  }
  render();
  const target =
    next === 'releaseDevice'
      ? submitButton
      : !nameField.el.hidden && !nameField.input.value
        ? nameField.input
        : codeField.input;
  target.focus();
}

function closeForm(): void {
  mode = 'none';
  render();
}

/** Keeps focus in the section when the focused element is hidden. */
function keepFocus(fallback: HTMLElement): void {
  const focused = document.activeElement as HTMLElement | null;
  if (focused && section.contains(focused) && focused.offsetParent !== null) {
    return;
  }
  if (fallback.offsetParent !== null) fallback.focus();
  else {
    section
      .querySelector<HTMLElement>('button:not([hidden]):not(:disabled)')
      ?.focus();
  }
}

function showError(action: NamesAction, error: NamesError): void {
  if (error.status === 404) {
    available = false;
    return;
  }
  // The browser's name changed meanwhile (another tab): show it, so
  // "Release this device" is offered.
  if (error.code === 'device_has_name' && error.name) {
    mine = error.name;
    mode = 'none';
  }
  setMessage(namesErrorText(action, error), true);
}

function afterGetName(name: string): void {
  mine = name;
  needsRejoin = rejoin !== undefined;
  recheckNameStatus();
}

const REJOIN_HINT =
  ' You are in a game that started before: rejoin to play under it, or the server treats you as a guest and renames you.';

async function run(work: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  setMessage('Working...');
  render();
  try {
    await work();
  } finally {
    busy = false;
    render();
  }
}

claimButton.addEventListener('click', () => {
  const name = nickname();
  if (!name) return;
  void run(async () => {
    const result = await claimName(name);
    if (!result.ok) {
      showError('claim', result.error);
      return;
    }
    afterGetName(result.value.name);
    shownCode = result.value;
    setMessage(`“${result.value.name}” is yours.`);
  }).then(() => keepFocus(copyButton));
});

copyButton.addEventListener('click', () => {
  void copyLink(codeValue).then((copied) => {
    setMessage(
      copied
        ? 'Copied. Paste it somewhere safe.'
        : 'Copy the selected code by hand (Ctrl+C, or long-press on a phone).',
      !copied
    );
    render();
  });
});

savedButton.addEventListener('click', () => {
  const name = shownCode?.name ?? mine;
  shownCode = undefined;
  setMessage(
    `“${name}” is claimed.` + (needsRejoin && rejoin ? REJOIN_HINT : '')
  );
  render();
  keepFocus(rejoinButton.hidden ? releaseDeviceButton : rejoinButton);
});

signInButton.addEventListener('click', () => openForm('signin'));
releaseOtherButton.addEventListener('click', () => openForm('releaseName'));
releaseNameButton.addEventListener('click', () => openForm('releaseName'));
releaseDeviceButton.addEventListener('click', () => openForm('releaseDevice'));
cancelButton.addEventListener('click', () => {
  setMessage('');
  closeForm();
  keepFocus(mine ? releaseDeviceButton : signInButton);
});
rejoinButton.addEventListener('click', () => {
  if (!rejoin || !mine) return;
  needsRejoin = false;
  setMessage(`Rejoining as “${mine}”...`);
  render();
  rejoin(mine);
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const current = mode;
  const name = nameField.el.hidden ? '' : nameField.input.value.trim();
  const code = codeField.input.value.trim();
  if (current !== 'releaseDevice') {
    if (!nameField.el.hidden && !name) {
      setMessage('Type the claimed name.', true);
      render();
      nameField.input.focus();
      return;
    }
    if (!looksLikeRecoveryCode(code)) {
      setMessage(
        `A recovery code is 16 letters and digits, like ${RECOVERY_CODE_EXAMPLE}.`,
        true
      );
      render();
      codeField.input.focus();
      return;
    }
  }
  void run(async () => {
    if (current === 'signin') {
      const result = await signIn(name, code);
      if (!result.ok) return showError('signin', result.error);
      useAsNickname(result.value);
      afterGetName(result.value);
      mode = 'none';
      setMessage(
        `Signed in: this browser has “${result.value}”.` +
          (rejoin ? REJOIN_HINT : '')
      );
    } else if (current === 'releaseDevice') {
      const result = await releaseDevice();
      if (!result.ok) return showError('release', result.error);
      const old = mine;
      mine = '';
      needsRejoin = false;
      mode = 'none';
      recheckNameStatus();
      setMessage(
        `This browser no longer has “${old}”. Its recovery code still works.` +
          (rejoin
            ? ' If you are playing under it now, the server renames you.'
            : '')
      );
    } else {
      const result = await releaseName(name, code);
      if (!result.ok) return showError('releaseName', result.error);
      if (!name || name.toLowerCase() === mine.toLowerCase()) mine = '';
      // Another browser's name released with its code: ask who we are.
      else await loadMyName();
      needsRejoin = needsRejoin && mine !== '';
      mode = 'none';
      codeField.input.value = '';
      recheckNameStatus();
      setMessage(
        `Released “${result.value}”. Anyone can claim it now; its leaderboard row is kept.`
      );
    }
  }).then(() => keepFocus(mode === 'none' ? claimButton : codeField.input));
});

/** On the login page, a sign-in also puts the name in the nickname field. */
function useAsNickname(name: string): void {
  if (rejoin || currentPlayerName() === name) return;
  setPlayerNameField(name);
}

async function loadMyName(): Promise<void> {
  const result = await fetchMyName();
  if (!result.ok) return;
  available = result.value.available;
  if (result.value.available) {
    if (result.value.name !== mine) needsRejoin = false;
    mine = result.value.name;
  }
}

/**
 * Asks the server again which name this browser has (the panel opened;
 * another browser may have released it). Also renews the cookie.
 */
export function refreshNameSection(): void {
  if (!busy && !shownCode && mode === 'none') setMessage('');
  render();
  loading ??= loadMyName().finally(() => {
    loading = undefined;
    render();
  });
}

/**
 * In game, rejoin(name) drops and reopens the game connection as name, so
 * a claim made now counts (main.ts); undefined back on the login page.
 */
export function setNamesRejoin(
  handler: ((name: string) => void) | undefined
): void {
  rejoin = handler;
  if (!handler) needsRejoin = false;
  render();
}

/** Builds the section (once); the settings panel puts it under the invite. */
export function createNameSection(): HTMLElement {
  refreshNameSection();
  return section;
}
