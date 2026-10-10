// Invite links (no DOM, so the smoke test can run it in node). A link is the
// page address plus `?join=1`; opening it downloads the game and connects
// with the saved nickname, or asks for one first.

export const JOIN_PARAM = 'join';

/** What the page does on load. */
export type JoinAction =
  /** No invite link: the normal launcher. */
  | 'none'
  /** Invite link and a saved nickname: download, then connect. */
  | 'connect'
  /** Invite link without a usable nickname: focus the nickname field; the
   *  game connects on its own once it has loaded. */
  | 'ask-name';

/**
 * The link to share: the page's origin and path plus `?join=1`, nothing
 * else (no name, no other query, no hash).
 */
export function inviteLink(origin: string, pathname: string): string {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${origin}${path}?${JOIN_PARAM}=1`;
}

/** True when the query string (location.search) asks to join: `join=1`. */
export function hasJoinParam(search: string): boolean {
  return new URLSearchParams(search).get(JOIN_PARAM) === '1';
}

/**
 * The address to put in the address bar after the invite was used: `href`
 * without any `join` parameter (other parameters and the hash are kept), as
 * a path for history.replaceState. Undefined when there is nothing to remove.
 */
export function withoutJoinParam(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (!url.searchParams.has(JOIN_PARAM)) return undefined;
  url.searchParams.delete(JOIN_PARAM);
  return url.pathname + url.search + url.hash;
}

/**
 * Decides what to do on load. savedName is the stored nickname after the
 * login form's own clean-up (sanitizePlayerName); an empty one can't be
 * used, just as the form's button stays disabled without a nickname.
 */
export function joinAction(
  joinRequested: boolean,
  savedName: string
): JoinAction {
  if (!joinRequested) return 'none';
  return savedName.trim() === '' ? 'ask-name' : 'connect';
}
