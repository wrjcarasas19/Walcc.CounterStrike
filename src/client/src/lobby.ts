/**
 * Lobby status on the login page: the map, the player count and the names,
 * from the server's `/status.json` (status.go), refreshed while the page is
 * visible. Names come from players, so they only ever go in through
 * textContent. If the server doesn't answer, the panel keeps what it last
 * showed (or stays hidden).
 */

export interface LobbyPlayer {
  name: string;
  frags: number;
  bot: boolean;
}

export interface LobbyStatus {
  map: string;
  playerCount: number;
  maxPlayers: number;
  bots: number;
  players: LobbyPlayer[];
  /** mp_timelimit in minutes (0 = none), null if unknown. */
  timeLimit: number | null;
  /** Seconds, null with no time limit or without AMX Mod X. */
  timeLeft: number | null;
  /** '' if unknown. */
  nextMap: string;
}

const STATUS_URL = '/status.json';
const REFRESH_MS = 5_000;
const REQUEST_TIMEOUT_MS = 4_000;
const NAME_MAX = 64;

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Checks the shape of a `/status.json` body; undefined if it's wrong. */
export function parseLobbyStatus(json: unknown): LobbyStatus | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const data = json as Record<string, unknown>;
  if (
    typeof data.map !== 'string' ||
    data.map === '' ||
    !isCount(data.playerCount) ||
    !isCount(data.maxPlayers) ||
    !isCount(data.bots) ||
    !Array.isArray(data.players)
  ) {
    return undefined;
  }
  const players: LobbyPlayer[] = [];
  for (const entry of data.players as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const p = entry as Record<string, unknown>;
    if (typeof p.name !== 'string' || !Number.isInteger(p.frags)) {
      return undefined;
    }
    players.push({
      name: p.name.slice(0, NAME_MAX),
      frags: p.frags as number,
      bot: p.bot === true,
    });
  }
  const timeLimit =
    typeof data.timeLimit === 'number' && data.timeLimit >= 0
      ? data.timeLimit
      : null;
  return {
    map: data.map,
    playerCount: data.playerCount,
    maxPlayers: data.maxPlayers,
    bots: data.bots,
    players,
    timeLimit,
    timeLeft: isCount(data.timeLeft) ? data.timeLeft : null,
    nextMap: typeof data.nextMap === 'string' ? data.nextMap : '',
  };
}

/** "de_dust2 · 5/16 players" */
export function summaryText(status: LobbyStatus): string {
  const noun = status.maxPlayers === 1 ? 'player' : 'players';
  return `${status.map} · ${status.playerCount}/${status.maxPlayers} ${noun}`;
}

/** "12:07 left", or '' when there is no time limit or it's unknown. */
export function timeLeftText(status: LobbyStatus): string {
  if (status.timeLeft === null) return '';
  const minutes = Math.floor(status.timeLeft / 60);
  const seconds = status.timeLeft % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')} left`;
}

/** Most frags first, then by name, so the list reads like the scoreboard. */
export function sortPlayers(players: readonly LobbyPlayer[]): LobbyPlayer[] {
  return [...players].sort(
    (a, b) => b.frags - a.frags || a.name.localeCompare(b.name)
  );
}

/** Fetches the status once; undefined if the server doesn't answer. */
export async function fetchLobbyStatus(): Promise<LobbyStatus | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(STATUS_URL, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return parseLobbyStatus(await response.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let generation = 0;

function elements() {
  const panel = document.getElementById('lobby');
  if (!panel) return undefined;
  return {
    panel,
    summary: document.getElementById('lobby-summary')!,
    time: document.getElementById('lobby-time')!,
    players: document.getElementById('lobby-players')!,
    empty: document.getElementById('lobby-empty')!,
  };
}

function render(status: LobbyStatus): void {
  const el = elements();
  if (!el) return;
  el.summary.textContent = summaryText(status);
  el.time.textContent = timeLeftText(status);
  const rows = sortPlayers(status.players).map((player) => {
    const row = document.createElement('li');
    row.className = 'lobby-player';
    const name = document.createElement('span');
    name.className = 'lobby-name';
    name.textContent = player.name;
    row.append(name);
    if (player.bot) {
      const tag = document.createElement('span');
      tag.className = 'lobby-bot';
      tag.textContent = 'Bot';
      row.append(tag);
    }
    const frags = document.createElement('span');
    frags.className = 'lobby-frags';
    frags.textContent = String(player.frags);
    frags.title = 'Score';
    row.append(frags);
    return row;
  });
  el.players.replaceChildren(...rows);
  el.players.hidden = rows.length === 0;
  el.empty.textContent =
    status.playerCount === 0
      ? 'Nobody is playing right now.'
      : rows.length === 0
        ? 'The server hides player names.'
        : '';
  el.empty.hidden = el.empty.textContent === '';
  el.panel.hidden = false;
}

async function refresh(): Promise<void> {
  const current = ++generation;
  const status = await fetchLobbyStatus();
  if (!running || current !== generation) return;
  if (status) render(status);
  schedule();
}

function schedule(): void {
  clearTimeout(timer);
  timer = undefined;
  if (running && document.visibilityState === 'visible') {
    timer = setTimeout(() => void refresh(), REFRESH_MS);
  }
}

function onVisibilityChange(): void {
  if (!running) return;
  if (document.visibilityState === 'visible') {
    void refresh();
  } else {
    clearTimeout(timer);
    timer = undefined;
  }
}

/** Shows the lobby status on the login page and keeps it fresh. */
export function startLobby(): void {
  if (running || !elements()) return;
  running = true;
  document.addEventListener('visibilitychange', onVisibilityChange);
  if (document.visibilityState === 'visible') void refresh();
}

/** Stops refreshing (the login page is gone). */
export function stopLobby(): void {
  running = false;
  generation++;
  clearTimeout(timer);
  timer = undefined;
  document.removeEventListener('visibilitychange', onVisibilityChange);
}
