import type { Game } from './engine';

/**
 * The game of the server that served this page: "valve" on the Half-Life
 * deathmatch server (the hl-web-server compose service), "cstrike"
 * otherwise. Read from the `game` field of `/status.json`
 * (apps/server/status.go). Only an answer is kept: when the server doesn't
 * answer (busy, or `npm run dev` with nothing behind it), this says
 * Counter-Strike and the next call asks again.
 */
const STATUS_URL = '/status.json';
const REQUEST_TIMEOUT_MS = 4_000;

let known: Game | undefined;

export async function serverGame(): Promise<Game> {
  if (known) return known;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(STATUS_URL, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return 'cstrike';
    const body = (await response.json()) as { game?: unknown } | null;
    known = body?.game === 'valve' ? 'valve' : 'cstrike';
    return known;
  } catch {
    return 'cstrike';
  } finally {
    clearTimeout(timeout);
  }
}
