import { getSessionStats, onHudEvent, type HudEvent } from './hud';
import {
  KILL_CARD_MS,
  KILL_INFO_WAIT_MS,
  allTimeDuel,
  allTimeLineText,
  bombCard,
  createBombDeathDetector,
  detailTags,
  detailsText,
  duelUrl,
  hasDuelLines,
  killCardFor,
  mapLineText,
  parseDuel,
  streakText,
  type KillCard,
  type WeaponKind,
} from './killcard-text';
import {
  killInfoMatches,
  killInfoSupported,
  parseKillInfo,
  type KillInfo,
} from './killinfo';
import { getSettings, onSettingsChange } from './settings/store';
import type { Duel, KillEvent } from './stats';

// "Killed by" card (D.4): when the local player dies, who killed them, with
// what, the killer's HP / armour / distance (`killinfo`, cs16-client
// 0.0.10+), the head-to-head this map (stats.ts) and all time (GET /duel),
// and the killer's streak. Lower centre, above the clock, never over the
// crosshair (style.css), never takes input. Up for KILL_CARD_MS, through a
// respawn or a new round; only the end of the map (intermission, reset) or
// the next death takes it down sooner. The texts are in killcard-text.ts.

const REQUEST_TIMEOUT_MS = 5_000;
/** A failed /duel request may be tried again for the same killer after this. */
const RETRY_MS = 60_000;
/**
 * The server reads the game logs every 2 s, so /duel is asked this long
 * after the death, when it surely has the kill: asked at once, it may or
 * may not have it, and the line could be one too high for the whole map.
 */
const FETCH_DELAY_MS = 2_500;

type AllTime =
  | { state: 'loading' }
  | { state: 'none'; at: number }
  | { state: 'ok'; server: Duel; mapAtFetch: Duel };

type Current = {
  card: KillCard;
  kill?: KillEvent;
  info?: KillInfo;
  /** Local player's name when they died (for the duel lines). */
  me: string;
};

const ICONS: Record<Exclude<WeaponKind, ''>, string> = {
  gun: 'M2 8h15V6h3v2h2v3h-5l-1 2h-3l-1 3H8l1-5H2z',
  knife: 'M2 13l13-9 2 2-9 9H5zm13 1l3-3 4 4-3 3z',
  grenade:
    'M12 6a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm-2-4h4v3h-4zm5 0h3v2h-3l1 2-2 1z',
};

const killInfoExpected = killInfoSupported(__CS16_CLIENT_VERSION__);

let root: HTMLElement | undefined;
let current: Current | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let waitTimer: ReturnType<typeof setTimeout> | undefined;
let wasAlive = false;
// Cleared with every map (reset event): fetched once per killer per map.
const allTime = new Map<string, AllTime>();
let generation = 0;
const bomb = createBombDeathDetector();

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function weaponIcon(kind: Exclude<WeaponKind, ''>): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'hud-icon hud-kc-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[kind]);
  svg.append(path);
  return svg;
}

function teamClass(team: string): string {
  return team === 'CT' ? 'ct' : team === 'T' ? 't' : '';
}

function allTimeText(me: string, killer: string): string {
  const entry = allTime.get(killer);
  if (entry?.state !== 'ok') return '';
  const duel = allTimeDuel(
    entry.server,
    entry.mapAtFetch,
    getSessionStats().duel(me, killer)
  );
  return duel ? allTimeLineText(duel) : '';
}

function render(): void {
  if (!root || !current) return;
  const { card, info, me } = current;
  const children: HTMLElement[] = [];

  const head = el('div', 'hud-kc-head');
  head.append(el('span', 'hud-kc-title', card.title));
  if (card.killer) {
    head.append(
      ' ',
      el('span', `hud-kc-killer ${teamClass(card.killerTeam)}`, card.killer)
    );
  }
  children.push(head);

  if (card.weapon) {
    const weapon = el('div', 'hud-kc-weapon');
    if (card.weaponKind) weapon.append(weaponIcon(card.weaponKind));
    weapon.append(el('span', 'hud-kc-weapon-name', card.weapon));
    if (card.headshot) weapon.append(el('span', 'hud-kc-tag hs', 'Headshot'));
    for (const tag of info ? detailTags(info) : []) {
      weapon.append(el('span', 'hud-kc-tag', tag));
    }
    children.push(weapon);
  }
  if (info) children.push(el('div', 'hud-kc-details', detailsText(info)));

  if (hasDuelLines(card.kind) && me) {
    const stats = getSessionStats();
    children.push(
      el(
        'div',
        'hud-kc-duel',
        mapLineText(stats.duel(me, card.killer), card.killer)
      )
    );
    const all = allTimeText(me, card.killer);
    if (all) children.push(el('div', 'hud-kc-duel', all));
    const streak = streakText(card.killer, stats.get(card.killer)?.streak);
    if (streak) children.push(el('div', 'hud-kc-streak', streak));
  }

  root.className = `hud-killcard ${card.kind}`;
  root.replaceChildren(...children);
  root.hidden = false;
}

function hide(): void {
  clearTimeout(hideTimer);
  clearTimeout(waitTimer);
  hideTimer = waitTimer = undefined;
  current = undefined;
  if (root) {
    root.hidden = true;
    root.replaceChildren();
  }
}

function show(next: Current, wait: boolean): void {
  hide();
  if (!getSettings().killerCard) return;
  current = next;
  hideTimer = setTimeout(hide, KILL_CARD_MS);
  if (wait) {
    waitTimer = setTimeout(() => {
      waitTimer = undefined;
      render();
    }, KILL_INFO_WAIT_MS);
  } else {
    render();
  }
}

/** GET /duel; undefined on 404 (no leaderboard), 429, 503 or any error. */
async function fetchDuel(
  me: string,
  killer: string
): Promise<Duel | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(duelUrl(me, killer), {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return parseDuel(await response.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetches the all-time record once per killer per map, FETCH_DELAY_MS after
 * the death, and keeps the map's counts at that time to add later kills.
 */
function loadAllTime(me: string, killer: string): void {
  const entry = allTime.get(killer);
  if (entry?.state === 'ok' || entry?.state === 'loading') return;
  if (entry?.state === 'none' && performance.now() - entry.at < RETRY_MS) {
    return;
  }
  allTime.set(killer, { state: 'loading' });
  const request = generation;
  setTimeout(() => {
    if (request !== generation) return;
    void fetchDuel(me, killer).then((server) => {
      if (request !== generation) return;
      allTime.set(
        killer,
        server
          ? {
              state: 'ok',
              server,
              mapAtFetch: getSessionStats().duel(me, killer),
            }
          : { state: 'none', at: performance.now() }
      );
      if (server && current?.card.killer === killer && !waitTimer) render();
    });
  }, FETCH_DELAY_MS);
}

function onKill(kill: KillEvent): void {
  const stats = getSessionStats();
  const me = stats.localName();
  const card = killCardFor(kill, me);
  if (!card) return;
  bomb.killed(performance.now());
  if (hasDuelLines(card.kind)) loadAllTime(me, card.killer);
  // Only a player killer gets details; never wait on a bridge without them.
  const wait = killInfoExpected && !!card.killer && !!kill.killerUserid;
  show({ card, kill, me }, wait);
}

function onKillInfo(payload: unknown): void {
  const info = parseKillInfo(payload);
  if (!info || !current?.kill || current.info) return;
  if (!killInfoMatches(current.kill, info)) return;
  current.info = info;
  if (waitTimer) {
    clearTimeout(waitTimer);
    waitTimer = undefined;
  }
  render();
}

function onEvent(event: HudEvent): void {
  const now = performance.now();
  switch (event.type) {
    case 'kill':
      onKill(event.payload);
      break;
    case 'killinfo':
      onKillInfo(event.payload);
      break;
    case 'alive': {
      const { alive, spectating } = event.payload;
      const playing = alive && !spectating;
      if (!alive && wasAlive && bomb.died(now)) {
        show({ card: bombCard(), me: '' }, false);
      }
      wasAlive = playing;
      break;
    }
    case 'round':
      if (bomb.round(event.payload.reason, now)) {
        show({ card: bombCard(), me: '' }, false);
      }
      break;
    case 'intermission':
      if (event.payload.active) hide();
      break;
    case 'reset':
      hide();
      generation++;
      allTime.clear();
      bomb.reset();
      wasAlive = false;
      break;
  }
}

/** Starts listening for deaths of the local player. Call once. */
export function startKillCard(): void {
  if (root) return;
  root = document.getElementById('hud-killcard') ?? undefined;
  if (!root) return;
  onHudEvent(onEvent);
  onSettingsChange((settings) => {
    if (!settings.killerCard) hide();
  });
}
