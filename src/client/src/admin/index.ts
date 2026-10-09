import type { Xash3D } from 'xash3d-fwgs';
import {
  attachCore,
  detachCore,
  getSavedPassword,
  isBusy,
  isLoggedIn,
  login,
  logout,
  refreshSession,
  setPassword,
  setStatus,
  usesApi,
  type AdminTab,
} from './core';
import { createModal } from '../modal';
import { botsTab } from './bots';
import { mapTab } from './map';
import { matchTab } from './match';
import { messagesTab } from './messages';
import { playersTab } from './players';

// HTML admin menu (F4): runs server commands through the admin API (log in
// with ADMIN_PASSWORD) or, on a server without it, through rcon, without
// opening the engine console. This file is the shell: tabs and the login or
// rcon password (open, close, focus and keys come from ../modal.ts); each
// tab is its own module, and core.ts has the shared helpers.

// To add a tab, write a module that exports an AdminTab and list it here.
const TABS: readonly AdminTab[] = [
  mapTab,
  matchTab,
  playersTab,
  botsTab,
  messagesTab,
];

const menu = document.getElementById('admin-menu')!;
const form = document.getElementById('admin-form') as HTMLFormElement;
const tabList = document.getElementById('admin-tabs')!;
const panels = document.getElementById('admin-panels')!;
const passwordInput = document.getElementById(
  'admin-password'
) as HTMLInputElement;
const passwordLabel = document.getElementById('admin-password-label')!;
const authField = document.getElementById('admin-auth')!;
const loginButton = document.getElementById('admin-login') as HTMLButtonElement;
const sessionRow = document.getElementById('admin-session')!;
const logoutButton = document.getElementById(
  'admin-logout'
) as HTMLButtonElement;

let engine: Xash3D | undefined;
let active = TABS[0];

const tabButtons = TABS.map((tab) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'admin-tab';
  button.id = `admin-tab-${tab.id}`;
  button.setAttribute('role', 'tab');
  button.textContent = tab.label;
  button.addEventListener('click', () => select(tab, true));
  tab.panel.id = `admin-panel-${tab.id}`;
  tab.panel.setAttribute('role', 'tabpanel');
  tab.panel.setAttribute('aria-labelledby', button.id);
  return button;
});
tabList.append(...tabButtons);

function refreshTabs(): void {
  renderAuth();
  for (const tab of TABS) tab.refresh?.();
}

// Rcon: the password field. Admin API: the field with a Log in button, or
// "Logged in" with Log out.
function renderAuth(): void {
  const api = usesApi();
  const loggedIn = isLoggedIn();
  const hadFocus = authField.contains(document.activeElement);
  passwordLabel.textContent = api ? 'Admin password' : 'Rcon password';
  passwordInput.maxLength = api ? 256 : 64;
  authField.hidden = loggedIn;
  sessionRow.hidden = !loggedIn;
  loginButton.hidden = !api;
  loginButton.disabled = passwordInput.value === '';
  // The focused field just went away (logged in): move on to the tab.
  if (hadFocus && loggedIn) focusActive();
}

function focusActive(): void {
  (active.focusTarget?.() ?? tabButtons[TABS.indexOf(active)]).focus();
}

async function submitLogin(): Promise<void> {
  if (!(await login(passwordInput.value))) {
    passwordInput.select();
    return;
  }
  passwordInput.value = '';
}

function renderTabs(): void {
  TABS.forEach((tab, i) => {
    const selected = tab === active;
    const button = tabButtons[i];
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    // Only the active panel is in the form, so a hidden tab's submit
    // button can't become the form's default button.
    if (selected) button.setAttribute('aria-controls', tab.panel.id);
    else button.removeAttribute('aria-controls');
  });
  panels.replaceChildren(active.panel);
}

function select(tab: AdminTab, focusTab: boolean): void {
  if (tab !== active) {
    active.hide?.();
    active = tab;
    if (!isBusy()) setStatus('');
  }
  renderTabs();
  active.show?.();
  active.refresh?.();
  if (focusTab) tabButtons[TABS.indexOf(tab)].focus();
}

const modal = createModal({
  backdrop: menu,
  panel: form,
  toggleKey: 'F4',
  canOpen: () => engine !== undefined,
  onOpen,
  onClose: () => active.hide?.(),
  onKeyDown: (event) => {
    const tab = tabButtons.indexOf(event.target as HTMLButtonElement);
    return tab !== -1 && moveTab(event.key, tab);
  },
});

function onOpen(): void {
  if (!isBusy()) setStatus('');
  const saved = usesApi() ? '' : getSavedPassword();
  passwordInput.value = saved;
  setPassword(saved);
  select(active, false);
  if (saved || isLoggedIn()) focusActive();
  else passwordInput.focus();
  // The session may have expired (or the server restarted) since the last
  // look; renderAuth moves focus on if this logs in.
  void refreshSession();
}

// Arrow keys, Home and End move between tabs and select them (ARIA tabs
// pattern with automatic activation).
function moveTab(key: string, from: number): boolean {
  let to: number;
  if (key === 'ArrowLeft') to = (from - 1 + TABS.length) % TABS.length;
  else if (key === 'ArrowRight') to = (from + 1) % TABS.length;
  else if (key === 'Home') to = 0;
  else if (key === 'End') to = TABS.length - 1;
  else return false;
  select(TABS[to], true);
  return true;
}

passwordInput.addEventListener('input', () => {
  // The admin password stays in the field; only rcon uses setPassword.
  if (usesApi()) renderAuth();
  else setPassword(passwordInput.value);
});
loginButton.addEventListener('click', () => void submitLogin());
logoutButton.addEventListener('click', () => {
  void logout().then(() => passwordInput.focus());
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  // Enter in the admin password field logs in.
  if (usesApi() && !isLoggedIn()) {
    if (document.activeElement === passwordInput) void submitLogin();
    return;
  }
  active.submit?.();
});

renderTabs();
renderAuth();

/** Enables the admin menu (toggled with F4) for a running game. */
export { setVoiceState } from './players';

export function attachAdmin(target: Xash3D): void {
  detachAdmin();
  engine = target;
  attachCore(target, refreshTabs, () => modal.close(false));
}

/** Closes the admin menu and disables it (connection lost). */
export function detachAdmin(): void {
  modal.close(false);
  detachCore();
  engine = undefined;
}
