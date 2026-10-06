/**
 * Leaderboard on the login page: the top players by kills from the
 * server's `/leaderboard` (leaderboard.go), totals kept across maps and
 * restarts. Shown as a closed "Top players" section under the lobby status;
 * it is fetched once when the page opens (to know whether the server has a
 * leaderboard at all) and again when opened, at most every REFRESH_MS.
 * Names are whatever players typed, so they only go in through textContent.
 */

export interface LeaderboardEntry {
  rank: number;
  name: string;
  kills: number;
  deaths: number;
  /** kills / max(1, deaths), 2 decimals. */
  kd: number;
  headshots: number;
  /** Whole percent of kills; null with no kills. */
  headshotPercent: number | null;
  rounds: number;
}

export interface Leaderboard {
  players: LeaderboardEntry[];
  /** Whether bots are listed (LEADERBOARD_BOTS on the server). */
  bots: boolean;
}

const LEADERBOARD_URL = '/leaderboard';
const REFRESH_MS = 30_000;
const REQUEST_TIMEOUT_MS = 4_000;
const NAME_MAX = 64;
const ROWS_MAX = 20;

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Checks the shape of a `/leaderboard` body; undefined if it's wrong. */
export function parseLeaderboard(json: unknown): Leaderboard | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const data = json as Record<string, unknown>;
  if (!Array.isArray(data.players)) return undefined;
  const players: LeaderboardEntry[] = [];
  for (const entry of (data.players as unknown[]).slice(0, ROWS_MAX)) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const p = entry as Record<string, unknown>;
    if (
      typeof p.name !== 'string' ||
      !isCount(p.rank) ||
      !isCount(p.kills) ||
      !isCount(p.deaths) ||
      typeof p.kd !== 'number' ||
      !Number.isFinite(p.kd) ||
      p.kd < 0 ||
      !isCount(p.headshots) ||
      !(p.headshotPercent === null || isCount(p.headshotPercent))
    ) {
      return undefined;
    }
    players.push({
      rank: p.rank,
      name: p.name.slice(0, NAME_MAX),
      kills: p.kills,
      deaths: p.deaths,
      kd: p.kd,
      headshots: p.headshots,
      headshotPercent: p.headshotPercent as number | null,
      rounds: isCount(p.rounds) ? p.rounds : 0,
    });
  }
  return { players, bots: data.bots === true };
}

/** "1.50" */
export function kdText(kd: number): string {
  return kd.toFixed(2);
}

/** "43%", or "-" with no kills. */
export function headshotText(percent: number | null): string {
  return percent === null ? '-' : `${percent}%`;
}

/** The line under the table. */
export function noteText(board: Leaderboard): string {
  const parts = [];
  if (board.players.length === 0) parts.push('No kills recorded yet.');
  if (!board.bots) parts.push('Bots are not listed.');
  parts.push('Names are not verified: anyone can play under any name.');
  return parts.join(' ');
}

/** Fetches the leaderboard once; undefined if the server has none. */
export async function fetchLeaderboard(): Promise<Leaderboard | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(LEADERBOARD_URL, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return parseLeaderboard(await response.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

let running = false;
let generation = 0;
let fetchedAt = 0;

function elements() {
  const panel = document.getElementById('leaderboard') as HTMLDetailsElement;
  if (!panel) return undefined;
  return {
    panel,
    rows: document.getElementById('leaderboard-rows')!,
    table: document.getElementById('leaderboard-table')!,
    note: document.getElementById('leaderboard-note')!,
  };
}

function cell(text: string, className: string, title?: string) {
  const td = document.createElement('td');
  td.className = className;
  td.textContent = text;
  if (title) td.title = title;
  return td;
}

function render(board: Leaderboard): void {
  const el = elements();
  if (!el) return;
  const rows = board.players.map((player) => {
    const row = document.createElement('tr');
    row.append(
      cell(String(player.rank), 'leaderboard-rank'),
      cell(player.name, 'leaderboard-name', player.name),
      cell(String(player.kills), 'leaderboard-number'),
      cell(String(player.deaths), 'leaderboard-number'),
      cell(kdText(player.kd), 'leaderboard-number'),
      cell(headshotText(player.headshotPercent), 'leaderboard-number')
    );
    return row;
  });
  el.rows.replaceChildren(...rows);
  el.table.hidden = rows.length === 0;
  el.note.textContent = noteText(board);
  el.panel.hidden = false;
}

async function refresh(): Promise<void> {
  const current = ++generation;
  fetchedAt = Date.now();
  const board = await fetchLeaderboard();
  if (!running || current !== generation || !board) return;
  render(board);
}

function onToggle(): void {
  const el = elements();
  if (running && el?.panel.open && Date.now() - fetchedAt >= REFRESH_MS) {
    void refresh();
  }
}

/** Looks for a leaderboard and shows the section if the server has one. */
export function startLeaderboard(): void {
  const el = elements();
  if (running || !el) return;
  running = true;
  el.panel.addEventListener('toggle', onToggle);
  void refresh();
}

/** Stops (the login page is gone). */
export function stopLeaderboard(): void {
  running = false;
  generation++;
  elements()?.panel.removeEventListener('toggle', onToggle);
}
