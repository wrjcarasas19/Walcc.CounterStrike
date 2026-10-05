import type { Xash3D } from 'xash3d-fwgs';
import { onMapLoad } from './hud';
import { getServerMaps, syncServerMaps } from './maps';

// HTML admin menu: changes the map through rcon without opening the engine
// console. The rcon reply is only printed to that console, so success is
// detected by the reset event the client sends once the new map is loaded.

const TOGGLE_KEY = 'F4';
// The engine hardcodes these (Escape: main menu, `/~: console), so unbind
// can't remove them; they never reach it while a game is running.
const ENGINE_BLOCKED_KEYS = new Set(['Escape', 'Backquote']);
// Covers loading a large map after the server has switched.
const CHANGE_TIMEOUT_MS = 15_000;
// rcon sends the password as a bare token: no spaces, quotes or control
// characters.
const PASSWORD_PATTERN = /^[!#-~]+$/;
const MAP_PATTERN = /^[A-Za-z0-9_.-]+$/;

const menu = document.getElementById('admin-menu')!;
const form = document.getElementById('admin-form') as HTMLFormElement;
const passwordInput = document.getElementById(
  'admin-password'
) as HTMLInputElement;
const mapList = document.getElementById('admin-maps')!;
const status = document.getElementById('admin-status')!;
const submit = document.getElementById('admin-submit') as HTMLButtonElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;

let engine: Xash3D | undefined;
// Kept in memory after a successful change so it isn't asked again until
// the page reloads; never written to storage.
let savedPassword = '';
let pending: { map: string; timer: ReturnType<typeof setTimeout> } | undefined;
let stopListening: (() => void) | undefined;

function isOpen(): boolean {
  return !menu.hidden;
}

function selectedMap(): string | undefined {
  return mapList.querySelector<HTMLInputElement>('input:checked')?.value;
}

function setStatus(message: string, error = false): void {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function refreshSubmit(): void {
  submit.disabled =
    pending !== undefined ||
    passwordInput.value === '' ||
    selectedMap() === undefined;
}

function renderMaps(): void {
  const previous = selectedMap();
  const maps = getServerMaps();
  mapList.replaceChildren(
    ...maps.map((name) => {
      const option = document.createElement('label');
      option.className = 'admin-map';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'admin-map';
      radio.value = name;
      radio.checked = name === previous;
      const label = document.createElement('span');
      label.textContent = name;
      option.append(radio, label);
      return option;
    })
  );
  if (maps.length === 0) {
    setStatus("The server's map list couldn't be loaded.", true);
  }
}

function clearPending(): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending = undefined;
}

function open(): void {
  if (!engine || isOpen()) return;
  document.exitPointerLock?.();
  renderMaps();
  // Picks up maps added to the server since the last sync.
  void syncServerMaps(engine).then(() => {
    if (isOpen()) renderMaps();
  });
  if (!pending) setStatus('');
  passwordInput.value = savedPassword;
  menu.hidden = false;
  refreshSubmit();
  if (savedPassword) {
    (mapList.querySelector<HTMLInputElement>('input:checked') ??
      mapList.querySelector<HTMLInputElement>('input'))?.focus();
  } else {
    passwordInput.focus();
  }
}

function close(relock: boolean): void {
  if (!isOpen()) return;
  menu.hidden = true;
  (document.activeElement as HTMLElement | null)?.blur();
  // Only allowed during a user gesture (the toggle key); otherwise the
  // engine locks again on the next click.
  if (relock) {
    try {
      void Promise.resolve(canvas.requestPointerLock()).catch(() => {});
    } catch {}
  }
}

function changeMap(): void {
  const password = passwordInput.value;
  const map = selectedMap();
  if (!engine || pending || !map) return;
  if (!PASSWORD_PATTERN.test(password)) {
    setStatus("The password can't contain spaces or quotes.", true);
    return;
  }
  // Names come from the server's listing, but they are pasted into a
  // command line.
  if (!MAP_PATTERN.test(map)) return;

  engine.Cmd_ExecuteString(`rcon_password "${password}"`);
  engine.Cmd_ExecuteString(`rcon changelevel ${map}`);
  setStatus(`Changing to ${map}...`);
  pending = {
    map,
    timer: setTimeout(() => {
      pending = undefined;
      setStatus(
        "The server didn't change the map. Check the password and try again.",
        true
      );
      refreshSubmit();
    }, CHANGE_TIMEOUT_MS),
  };
  refreshSubmit();
}

function onMapLoaded(): void {
  if (!pending) return;
  clearPending();
  savedPassword = passwordInput.value;
  setStatus('');
  close(false);
  refreshSubmit();
}

// Registered at module load, before the engine adds its own window
// listeners, so stopImmediatePropagation keeps keys from reaching the game.
// keyup is left alone so a key held when the menu opens is still released,
// except for blocked keys, whose keydown the engine never saw.
function onKey(event: KeyboardEvent): void {
  if (!engine) return;
  if (!isOpen() && ENGINE_BLOCKED_KEYS.has(event.code)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if (event.type === 'keydown' && event.code === TOGGLE_KEY) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    if (isOpen()) close(true);
    else open();
    return;
  }
  if (!isOpen()) return;
  if (event.type === 'keydown' && event.code === 'Escape') {
    event.preventDefault();
    close(false);
  }
  // Without preventDefault, typing and Enter still work in the form.
  event.stopImmediatePropagation();
}

window.addEventListener('keydown', onKey, { capture: true });
window.addEventListener('keypress', onKey, { capture: true });
window.addEventListener('keyup', onBlockedKeyUp, { capture: true });

function onBlockedKeyUp(event: KeyboardEvent): void {
  if (engine && ENGINE_BLOCKED_KEYS.has(event.code)) {
    event.stopImmediatePropagation();
  }
}

passwordInput.addEventListener('input', refreshSubmit);
mapList.addEventListener('change', refreshSubmit);
form.addEventListener('submit', (event) => {
  event.preventDefault();
  changeMap();
});
// Clicks on the backdrop close the menu; clicks on the panel don't.
menu.addEventListener('mousedown', (event) => {
  if (event.target === menu) close(false);
});

/** Enables the admin menu (toggled with F4) for a running game. */
export function attachAdmin(target: Xash3D): void {
  detachAdmin();
  engine = target;
  stopListening = onMapLoad(onMapLoaded);
}

/** Closes the admin menu and disables it (connection lost). */
export function detachAdmin(): void {
  close(false);
  clearPending();
  stopListening?.();
  stopListening = undefined;
  engine = undefined;
}
