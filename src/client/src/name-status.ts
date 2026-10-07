/**
 * Claimed names on the login page (E.4): while the nickname field changes,
 * ask the server's `GET /names/status?name=` (names.go) whether the name is
 * claimed, and say so under the field, so most people pick another name
 * before the server renames them in game. The server does the matching
 * (case, spaces, colour codes); the page sends the name as it would join
 * with. The `wc_player` cookie goes along (same origin), so the owner sees
 * "✓ yours". A server without claims (404) or any error shows nothing.
 */
import { sanitizePlayerName } from './player';

export interface NameStatus {
  claimed: boolean;
  mine: boolean;
}

export type NameStatusKind = 'taken' | 'mine';

const STATUS_URL = '/names/status';
const DEBOUNCE_MS = 400;
const REQUEST_TIMEOUT_MS = 4_000;
/** The server refuses longer names (statsNameMax). */
const NAME_MAX_BYTES = 64;

/** Checks the shape of a `/names/status` body; undefined if it's wrong. */
export function parseNameStatus(json: unknown): NameStatus | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const data = json as Record<string, unknown>;
  if (typeof data.claimed !== 'boolean' || typeof data.mine !== 'boolean') {
    return undefined;
  }
  return { claimed: data.claimed, mine: data.mine };
}

/** What to show under the field; null for nothing (unclaimed). */
export function nameStatusMessage(
  status: NameStatus | undefined
): { kind: NameStatusKind; text: string } | null {
  if (!status?.claimed) return null;
  return status.mine
    ? { kind: 'mine', text: '✓ yours' }
    : { kind: 'taken', text: 'This name is claimed by someone else' };
}

/** The name to ask about, or '' when there is nothing to ask. */
export function nameToCheck(input: string): string {
  const name = sanitizePlayerName(input);
  return new TextEncoder().encode(name).length > NAME_MAX_BYTES ? '' : name;
}

async function fetchNameStatus(
  name: string,
  signal: AbortSignal
): Promise<NameStatus | undefined> {
  const response = await fetch(
    `${STATUS_URL}?name=${encodeURIComponent(name)}`,
    { cache: 'no-store', credentials: 'same-origin', signal }
  );
  if (!response.ok) return undefined;
  return parseNameStatus(await response.json());
}

// Asks again about the current name (set by startNameStatus).
let recheck: (() => void) | undefined;

/**
 * Asks the server again about the name in the field, e.g. after this
 * browser claimed it, signed in or released it from the settings panel.
 */
export function recheckNameStatus(): void {
  recheck?.();
}

/** Starts watching the nickname field. */
export function startNameStatus(): void {
  const input = document.getElementById(
    'nickname-input'
  ) as HTMLInputElement | null;
  const note = document.getElementById('nickname-status');
  if (!input || !note) return;

  let timer: number | undefined;
  let pending: AbortController | undefined;
  let shown = '';

  const show = (name: string, status: NameStatus | undefined) => {
    const message = nameStatusMessage(status);
    shown = name;
    note.textContent = message?.text ?? '';
    if (message) note.dataset.kind = message.kind;
    else delete note.dataset.kind;
  };

  const check = () => {
    timer = undefined;
    const name = nameToCheck(input.value);
    if (name === shown && pending === undefined) return;
    pending?.abort();
    if (name === '') {
      pending = undefined;
      show('', undefined);
      return;
    }
    const controller = new AbortController();
    pending = controller;
    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );
    fetchNameStatus(name, controller.signal)
      .catch(() => undefined)
      .then((status) => {
        window.clearTimeout(timeout);
        // A newer check took over: drop this answer.
        if (pending !== controller) return;
        pending = undefined;
        show(name, status);
      });
  };

  input.addEventListener('input', () => {
    // The old answer is about another name: hide it until the new one.
    if (nameToCheck(input.value) !== shown) show('', undefined);
    window.clearTimeout(timer);
    timer = window.setTimeout(check, DEBOUNCE_MS);
  });
  recheck = () => {
    window.clearTimeout(timer);
    shown = '';
    pending?.abort();
    pending = undefined;
    check();
  };
  // The saved name (or the browser's autofill) is checked once at start.
  check();
}
