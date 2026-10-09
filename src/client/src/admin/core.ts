import type { Xash3D } from 'xash3d-fwgs';
import { onHudEvent, type HudEvent } from '../hud';
import {
  actionCommands,
  checkApiOnlyAction,
  type AdminAction,
  type ApiOnlyAction,
  type BanEntry,
  type ClaimEntry,
} from './actions';

export type {
  AdminAction,
  ApiOnlyAction,
  BanEntry,
  ClaimEntry,
} from './actions';

// Shared state and helpers for the admin menu tabs. Tabs send typed actions
// (sendAction). When the server has the admin API (ADMIN_PASSWORD), they go
// to POST /admin/command after a login, and the browser never sees the rcon
// password; otherwise they run as rcon commands with the typed rcon
// password. Neither way tells the page whether the game took effect, so a
// command is confirmed by a side effect that shows up as a HUD bridge event
// (expectEffect).

/** One tab of the admin menu. Register it in TABS in index.ts. */
export type AdminTab = {
  /** Used for element ids; letters, digits and dashes. */
  id: string;
  label: string;
  /** The tab's content, built once. Buttons that submit the form run submit. */
  panel: HTMLElement;
  /** The tab became visible (menu opened or tab selected). */
  show?(): void;
  /** The tab stopped being visible (menu closed or another tab selected). */
  hide?(): void;
  /** Enter in a field, or a submit button in the panel. */
  submit?(): void;
  /**
   * The password, the busy state or the engine changed: update which
   * controls are enabled.
   */
  refresh?(): void;
  /** Where focus goes when the tab is shown with a saved password. */
  focusTarget?(): HTMLElement | null;
};

export type EffectResult = 'done' | 'timeout' | 'cancelled';

// rcon sends the password as a bare token: no spaces, quotes or control
// characters.
const PASSWORD_PATTERN = /^[!#-~]+$/;
// Printable ASCII without the characters that end or escape a command
// (" ; \). Arguments are checked by each tab against a stricter pattern;
// this only catches a mistake.
const COMMAND_PATTERN = /^[ !#-:<-[\]-~]+$/;

const status = document.getElementById('admin-status')!;

let engine: Xash3D | undefined;
let password = '';
// Kept in memory after a confirmed command so it isn't asked again until
// the page reloads; never written to storage.
let savedPassword = '';
let pending:
  | {
      timer: ReturnType<typeof setTimeout>;
      stop: () => void;
      finish: (result: EffectResult) => void;
    }
  | undefined;
let changeListener: (() => void) | undefined;
let closeHandler: (() => void) | undefined;

// 'unknown' until GET /admin/session has answered once.
let mode: 'unknown' | 'rcon' | 'api' = 'unknown';
let loggedIn = false;
// Actions run one after another; after a failure the ones still queued are
// dropped (a preset's restart shouldn't run without its cvars).
let queue: Promise<void> = Promise.resolve();
let queued = 0;
let dropQueued = false;

function changed(): void {
  changeListener?.();
}

export function setStatus(message: string, error = false): void {
  status.textContent = message;
  status.classList.toggle('error', error);
}

/** The running game, or undefined while disconnected. */
export function getEngine(): Xash3D | undefined {
  return engine;
}

/** True while a command waits for its effect; tabs disable their actions. */
export function isBusy(): boolean {
  return pending !== undefined;
}

/**
 * True when commands can be sent: logged in to the admin API, or (rcon) a
 * password has been typed in (not checked yet).
 */
export function hasPassword(): boolean {
  return mode === 'api' ? loggedIn : mode === 'rcon' && password !== '';
}

/** True when the server has the admin API (ADMIN_PASSWORD). */
export function usesApi(): boolean {
  return mode === 'api';
}

/** True when logged in to the admin API. */
export function isLoggedIn(): boolean {
  return mode === 'api' && loggedIn;
}

/** Closes the menu without taking the pointer lock back. */
export function closeMenu(): void {
  closeHandler?.();
}

/**
 * Sends an action: to the admin API, or as rcon commands. Throws if a value
 * is invalid (see actionCommands); tabs check what the admin typed first.
 * Returns false, with the reason in the status line, if nothing was sent.
 * With the API the request finishes later; if it fails, the status line
 * says why and the awaited effect is cancelled.
 */
export function sendAction(action: AdminAction): boolean {
  const commands = actionCommands(action);
  if (!engine) return false;
  if (mode === 'api') {
    if (!loggedIn) {
      setStatus('Log in first.', true);
      return false;
    }
    enqueue(action);
    return true;
  }
  if (mode !== 'rcon') return false;
  for (const command of commands) {
    if (!sendRcon(command)) return false;
  }
  return true;
}

/**
 * Sends an action only the admin API has (bans), in order with the others.
 * Throws if a value is invalid. Returns undefined, with the reason in the
 * status line, if nothing was sent; otherwise a promise of the result, or
 * of undefined if the request failed (the status line says why).
 */
export function sendApiAction(
  action: ApiOnlyAction
): Promise<ApiResult | undefined> | undefined {
  checkApiOnlyAction(action);
  if (!engine || mode !== 'api') return undefined;
  if (!loggedIn) {
    setStatus('Log in first.', true);
    return undefined;
  }
  return enqueue(action).then((body) =>
    body
      ? {
          output: typeof body.output === 'string' ? body.output : '',
          bans: Array.isArray(body.bans) ? body.bans : [],
          nextMap: typeof body.nextMap === 'string' ? body.nextMap : '',
          claims: Array.isArray(body.claims) ? body.claims : [],
          voiceMuted: Array.isArray(body.voiceMuted)
            ? body.voiceMuted.filter(
                (id): id is number => Number.isInteger(id) && Number(id) > 0
              )
            : [],
        }
      : undefined
  );
}

/**
 * Runs `rcon <command>` with the typed password. Build the command only from
 * typed values (numbers, enum names, names checked against a pattern), never
 * from free text. Returns false, with the reason in the status line, if
 * nothing was sent.
 */
function sendRcon(command: string): boolean {
  if (!engine) return false;
  if (!PASSWORD_PATTERN.test(password)) {
    setStatus("The password can't contain spaces or quotes.", true);
    return false;
  }
  if (!COMMAND_PATTERN.test(command)) {
    throw new Error(`Refusing to send an unsafe rcon command: ${command}`);
  }
  engine.Cmd_ExecuteString(`rcon_password "${password}"`);
  engine.Cmd_ExecuteString(`rcon ${command}`);
  return true;
}

/**
 * Waits for a HUD event that shows the last command worked. Resolves 'done'
 * when check returns true (and keeps the password for the session),
 * 'timeout' after timeoutMs, or 'cancelled' when the game disconnects. Only
 * one effect is awaited at a time: isBusy() is true until it settles.
 */
export function expectEffect(
  check: (event: HudEvent) => boolean,
  timeoutMs: number
): Promise<EffectResult> {
  cancelEffect();
  const used = password;
  return new Promise((resolve) => {
    const finish = (result: EffectResult): void => {
      if (!pending) return;
      clearTimeout(pending.timer);
      pending.stop();
      pending = undefined;
      if (result === 'done') savedPassword = used;
      resolve(result);
      changed();
    };
    pending = {
      timer: setTimeout(() => finish('timeout'), timeoutMs),
      stop: onHudEvent((event) => {
        if (check(event)) finish('done');
      }),
      finish,
    };
    changed();
  });
}

function cancelEffect(): void {
  pending?.finish('cancelled');
}

type ApiBody = {
  error?: string;
  output?: string;
  loggedIn?: boolean;
  bans?: BanEntry[];
  nextMap?: string;
  claims?: ClaimEntry[];
  voiceMuted?: unknown[];
};

type ApiResponse = {
  status: number;
  body: ApiBody | undefined;
  retryAfter: number;
};

/** What a successful API-only action returned. */
export type ApiResult = {
  output: string;
  bans: BanEntry[];
  /** amx_nextmap, for the nextmap action; '' if the server has none. */
  nextMap: string;
  /** Claimed names, for the claims and release_claim actions. */
  claims: ClaimEntry[];
  /**
   * Admin-muted userids, for voice_mute and voice_unmute (the server
   * leaves the field out when nobody is muted).
   */
  voiceMuted: number[];
};

/** Undefined when the server couldn't be reached. */
async function callApi(
  path: string,
  body?: unknown
): Promise<ApiResponse | undefined> {
  try {
    const response = await fetch(
      path,
      body === undefined
        ? { cache: 'no-store', credentials: 'same-origin' }
        : {
            method: 'POST',
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
    );
    let parsed: ApiResponse['body'];
    if (response.headers.get('Content-Type')?.startsWith('application/json')) {
      parsed = (await response.json()) as ApiResponse['body'];
    }
    return {
      status: response.status,
      body: parsed,
      retryAfter: Number(response.headers.get('Retry-After')) || 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * Asks the server whether it has the admin API and whether this page is
 * logged in. A 404 (or anything that isn't the API's JSON, like the dev
 * server's index page) means rcon.
 */
export async function refreshSession(): Promise<void> {
  const response = await callApi('/admin/session');
  if (response === undefined) {
    if (mode === 'unknown') mode = 'rcon';
  } else if (
    response.status === 200 &&
    typeof response.body?.loggedIn === 'boolean'
  ) {
    mode = 'api';
    loggedIn = response.body.loggedIn;
  } else {
    mode = 'rcon';
  }
  changed();
}

/** Logs in to the admin API. Returns true on success. */
export async function login(adminPassword: string): Promise<boolean> {
  if (mode !== 'api' || adminPassword === '') return false;
  setStatus('Logging in...');
  const response = await callApi('/admin/login', { password: adminPassword });
  if (response?.status === 200) {
    loggedIn = true;
    setStatus('');
  } else if (response?.status === 401) {
    setStatus('Wrong password.', true);
  } else if (response?.status === 429) {
    const minutes = Math.max(1, Math.ceil(response.retryAfter / 60));
    setStatus(
      `Too many wrong passwords. Try again in ${minutes} minute${
        minutes === 1 ? '' : 's'
      }.`,
      true
    );
  } else {
    setStatus("Couldn't log in. Try again.", true);
  }
  changed();
  return loggedIn;
}

export async function logout(): Promise<void> {
  if (mode !== 'api') return;
  await callApi('/admin/logout', {});
  loggedIn = false;
  setStatus('Logged out.');
  changed();
}

/** Runs action after the queued ones; resolves to its body, or undefined. */
function enqueue(
  action: AdminAction | ApiOnlyAction
): Promise<ApiBody | undefined> {
  queued++;
  const result = queue.then(async () => {
    try {
      return dropQueued ? undefined : await postAction(action);
    } finally {
      queued--;
      if (queued === 0) dropQueued = false;
    }
  });
  queue = result.then(() => undefined);
  return result;
}

async function postAction(
  action: AdminAction | ApiOnlyAction
): Promise<ApiBody | undefined> {
  const response = await callApi('/admin/command', action);
  if (response?.status === 200) return response.body ?? {};
  dropQueued = true;
  if (response === undefined) {
    setStatus("Couldn't reach the server. Try again.", true);
  } else if (response.status === 401) {
    loggedIn = false;
    setStatus('Your admin session has ended. Log in again.', true);
  } else if (response.status === 504) {
    setStatus("The game server didn't answer. Try again.", true);
  } else if (response.status === 400 || response.status === 409) {
    setStatus(
      `The server refused the command: ${response.body?.error ?? 'invalid'}.`,
      true
    );
  } else if (response.body?.error) {
    setStatus(`The command failed: ${response.body.error}.`, true);
  } else {
    setStatus(`The command failed (HTTP ${response.status}).`, true);
  }
  cancelEffect();
  changed();
  return undefined;
}

// Used by the shell (index.ts) only.

export function attachCore(
  target: Xash3D,
  onChange: () => void,
  onClose: () => void
): void {
  engine = target;
  changeListener = onChange;
  closeHandler = onClose;
  void refreshSession();
}

export function detachCore(): void {
  cancelEffect();
  engine = undefined;
  changeListener = undefined;
  closeHandler = undefined;
}

export function setPassword(value: string): void {
  password = value;
  changed();
}

export function getSavedPassword(): string {
  return savedPassword;
}
