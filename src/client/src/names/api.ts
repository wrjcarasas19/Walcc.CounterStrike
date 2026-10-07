/**
 * The server's claimed-names API (src/server/names.go), without the DOM so
 * it can be checked on its own. The `wc_player` cookie is HttpOnly: the
 * page never sees it, it only goes along with these same-origin requests.
 *
 *   GET  /names/me                  {name} or {} for this browser
 *   POST /names/claim   {name}      -> {name, code} (sets the cookie)
 *   POST /names/signin  {name, code} -> {name}     (sets the cookie)
 *   POST /names/release {}          forgets this browser -> {}
 *   POST /names/release {all: true, code, name?} -> {released}
 *
 * Errors are {error: <code>, message} (plus `name` for device_has_name),
 * 429s carry Retry-After. A 404 means the server has no claimed names.
 */

export type NamesAction = 'claim' | 'signin' | 'release' | 'releaseName';

export interface NamesError {
  /** HTTP status; 0 when the server couldn't be reached. */
  status: number;
  /** The API's error code ('' for a body without one). */
  code: string;
  message: string;
  /** device_has_name: the name this browser already has. */
  name?: string;
  /** Seconds, from Retry-After (0 without one). */
  retryAfter: number;
}

export type NamesResult<T> =
  { ok: true; value: T } | { ok: false; error: NamesError };

/** What GET /names/me said: off (404), or this browser's name ('': none). */
export type MyName = { available: false } | { available: true; name: string };

const REQUEST_TIMEOUT_MS = 8_000;

export const RECOVERY_CODE_EXAMPLE = 'KJ7Q-M2XP-9WRT-4HCD';
const RECOVERY_CODE_LENGTH = 16;

/**
 * True if input can be a recovery code: 16 letters and digits once dashes
 * and spaces are dropped (the server also reads O as 0 and I, L as 1).
 */
export function looksLikeRecoveryCode(input: string): boolean {
  const code = input.replace(/[\s-]/g, '');
  return code.length === RECOVERY_CODE_LENGTH && /^[0-9A-Za-z]+$/.test(code);
}

function minutesText(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** A sentence for the player about a failed request. */
export function namesErrorText(action: NamesAction, error: NamesError): string {
  switch (error.code) {
    case 'invalid_name':
      return action === 'claim'
        ? `That name can't be claimed: ${error.message}.`
        : 'Type the claimed name.';
    case 'invalid_code':
      return `A recovery code is 16 letters and digits, like ${RECOVERY_CODE_EXAMPLE}.`;
    case 'wrong_code':
      return 'Wrong name or recovery code. After 5 wrong codes you have to wait 5 minutes.';
    case 'taken':
      return 'Someone already claimed that name. Pick another nickname, or sign in below if it is yours.';
    case 'device_has_name':
      return `This browser already has the name “${error.name ?? '?'}”. Release this device first, then try again.`;
    case 'no_claim':
      return action === 'claim'
        ? 'That name was just released. Try again.'
        : "That name isn't claimed any more. You can claim it.";
    case 'rate_limited':
      return 'Too many requests. Wait a few seconds and try again.';
    case 'locked_out':
      return `Too many wrong codes from your address. Try again in ${minutesText(error.retryAfter)}.`;
    case 'too_many_claims':
      return `Too many names claimed from your address. Try again in ${minutesText(error.retryAfter)}.`;
    case 'unavailable':
      return "The server's name list isn't available right now. Try again later.";
  }
  if (error.status === 0) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  if (error.status === 404) return "This server doesn't have claimed names.";
  if (error.status >= 500) {
    return `The server had a problem (HTTP ${error.status}). Try again later.`;
  }
  const detail = error.message || error.code;
  return detail
    ? `The server refused the request: ${detail}.`
    : `The server refused the request (HTTP ${error.status}).`;
}

/** Reads an error response's body into a NamesError. */
export function parseNamesError(
  status: number,
  body: unknown,
  retryAfter: number
): NamesError {
  const data =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  let code = text(data.error);
  let message = text(data.message);
  // checkPost's refusals (405/403/415) are {error: "<message>"}.
  if (!message && !/^[a-z_]+$/.test(code)) {
    message = code;
    code = '';
  }
  const error: NamesError = { status, code, message, retryAfter };
  if (typeof data.name === 'string') error.name = data.name;
  return error;
}

async function request(
  path: string,
  body?: unknown
): Promise<NamesResult<Record<string, unknown>>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      headers:
        body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    let json: unknown;
    if (response.headers.get('Content-Type')?.startsWith('application/json')) {
      json = await response.json().catch(() => undefined);
    }
    if (response.ok && typeof json === 'object' && json !== null) {
      return { ok: true, value: json as Record<string, unknown> };
    }
    return {
      ok: false,
      error: parseNamesError(
        response.ok ? 502 : response.status,
        json,
        Number(response.headers.get('Retry-After')) || 0
      ),
    };
  } catch {
    return {
      ok: false,
      error: { status: 0, code: '', message: '', retryAfter: 0 },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function stringField(
  result: NamesResult<Record<string, unknown>>,
  field: string
): NamesResult<string> {
  if (!result.ok) return result;
  const value = result.value[field];
  if (typeof value === 'string') return { ok: true, value };
  return {
    ok: false,
    error: { status: 502, code: '', message: '', retryAfter: 0 },
  };
}

/** This browser's claimed name; also renews the cookie for a year. */
export async function fetchMyName(): Promise<NamesResult<MyName>> {
  const result = await request('/names/me');
  if (!result.ok) {
    return result.error.status === 404
      ? { ok: true, value: { available: false } }
      : result;
  }
  const name = result.value.name;
  return {
    ok: true,
    value: { available: true, name: typeof name === 'string' ? name : '' },
  };
}

/** Claims name for this browser; the value is the recovery code. */
export async function claimName(
  name: string
): Promise<NamesResult<{ name: string; code: string }>> {
  const result = await request('/names/claim', { name });
  const code = stringField(result, 'code');
  if (!code.ok) return code;
  const claimed = stringField(result, 'name');
  return {
    ok: true,
    value: { name: claimed.ok ? claimed.value : name, code: code.value },
  };
}

/** Signs this browser in to a claimed name; the value is its spelling. */
export async function signIn(
  name: string,
  code: string
): Promise<NamesResult<string>> {
  return stringField(await request('/names/signin', { name, code }), 'name');
}

/** Forgets this browser (the claim and its code stay). */
export async function releaseDevice(): Promise<NamesResult<void>> {
  const result = await request('/names/release', {});
  return result.ok ? { ok: true, value: undefined } : result;
}

/**
 * Releases a claim with its code (name '' = this browser's); the value is
 * the released spelling.
 */
export async function releaseName(
  name: string,
  code: string
): Promise<NamesResult<string>> {
  const body: Record<string, unknown> = { all: true, code };
  if (name !== '') body.name = name;
  return stringField(await request('/names/release', body), 'released');
}
