import type { Xash3D } from 'xash3d-fwgs';
import { announce, getAnnouncerOptions } from './announcer';
import { createAnnouncerTriggers, modeSound } from './announcer-rules';
import {
  MODE_EVENT_CLIENT_VERSION,
  gunGameStrip,
  isGunGame,
  levelToast,
  parseModeState,
  versionAtLeast,
  type ModeState,
} from './gamemode';
import type { KillInfo } from './killinfo';
import { fetchLobbyStatus } from './lobby';
import { getSettings } from './settings/store';
import {
  createSessionStats,
  formatHeadshots,
  formatKd,
  type KillEvent,
  type KillResult,
} from './stats';
import {
  TEAM_NAMES,
  createRoundStartDetector,
  killsText,
  mapResultText,
  pickMapMvp,
  pickRoundMvp,
  roundReasonText,
  roundScoreText,
  roundTitle,
  summaryRows,
  type Intermission,
  type RoundEnd,
} from './rounds';

// HTML replacement for part of the stock HUD. The game client (cs16-client,
// web_bridge.cpp) calls Module.hudEvent(type, payload); the payloads are
// documented in web_bridge.h. With hud_html 1 the client skips drawing the
// elements rendered here.

type Team = 'CT' | 'T' | '';

type ScoreTeam = { score: number; players: number; avgPing: number };

export type ScorePlayer = {
  /** Slot (entity index, from 1); reused by the next player in the slot. */
  id: number;
  /**
   * The server's userid, for `kick #<userid>`: unique per connection, 0 if
   * the client couldn't read it. Missing before cs16-client 0.0.6.
   */
  userid?: number;
  name: string;
  // SPEC also covers unassigned players; '' before the first TeamInfo.
  team: Team | 'SPEC';
  frags: number;
  deaths: number;
  ping: number;
  dead: boolean;
  bomb: boolean;
  vip: boolean;
  bot: boolean;
  local: boolean;
};

export type Scores = {
  map: string;
  server: string;
  teams: { CT: ScoreTeam; T: ScoreTeam };
  // Slot order, unsorted.
  players: ScorePlayer[];
};

export type HudEvent =
  | { type: 'health'; payload: { hp: number } }
  | { type: 'armor'; payload: { ap: number; helmet: boolean } }
  | { type: 'money'; payload: { amount: number; delta: number } }
  | {
      type: 'weapon';
      // clip is -1 without a magazine, reserve -1 when no ammo is used.
      payload: { name: string; clip: number; reserve: number };
    }
  | { type: 'timer'; payload: { seconds: number; bombPlanted: boolean } }
  | {
      type: 'kill';
      payload: {
        killer: string;
        victim: string;
        weapon: string;
        headshot: boolean;
        killerTeam: Team;
        victimTeam: Team;
        /** Server userids, 0 for none; missing before cs16-client 0.0.7. */
        killerUserid?: number;
        victimUserid?: number;
      };
    }
  | { type: 'alive'; payload: { alive: boolean; spectating: boolean } }
  | { type: 'reset'; payload: Record<string, never> }
  | { type: 'round'; payload: RoundEnd }
  | { type: 'intermission'; payload: Intermission }
  | { type: 'scoreboard'; payload: { visible: boolean } }
  // From the menu library (mainui), not the game client.
  | { type: 'menu'; payload: { visible: boolean } }
  // Sent right before scoreboard { visible: true }, then every 0.5 s; also
  // every 0.5 s while the cvar hud_html_scores is 1 (see setLiveScores).
  | { type: 'scores'; payload: Scores }
  | { type: 'chat'; payload: ChatLine }
  | { type: 'mode'; payload: ModeState }
  // To the victim of a player kill, right after its `kill` event
  // (cs16-client 0.0.10+, wc_html_hud 1): see killinfo.ts. Read it with
  // parseKillInfo; the "Killed by" card (killcard.ts) shows it.
  | { type: 'killinfo'; payload: KillInfo };

/** One chat line from the client (cs16-client 0.0.8+), color codes stripped. */
export type ChatLine = {
  /** 'name': `name` is the old name, `text` the new one. 'notice': no sender. */
  kind: 'say' | 'name' | 'radio' | 'notice';
  /** Sender's slot (entity index), 0 if none. */
  slot: number;
  name: string;
  team: Team | 'SPEC';
  dead: boolean;
  /** say_team; always true for radio, which only reaches teammates. */
  teamOnly: boolean;
  /** '' unless the map sends locations. */
  location: string;
  text: string;
};

type HudModule = {
  hudEvent?: (type: string, payload: unknown) => void;
};

// Older client builds never send events; fall back to the stock HUD then.
// Counted from attachHud, so it also covers the in-game connect and map load.
const FALLBACK_MS = 10_000;
const LOW_HEALTH = 25;
// Same threshold as the stock clock's panic colour.
const PANIC_SECONDS = 20;
const MAX_KILLS = 5;
const KILL_TTL_MS = 6_000;
const KILL_FADE_MS = 500;
const MAX_CHAT = 6;
const CHAT_TTL_MS = 8_000;
const CHAT_FADE_MS = 500;
/** Lines kept for the chat history shown with the scoreboard. */
const MAX_CHAT_HISTORY = 50;
/** About mp_round_restart_delay (5 s): gone when the next round starts. */
const ROUND_BANNER_MS = 5_000;

const WEAPON_NAMES: Record<string, string> = {
  ak47: 'AK-47',
  deagle: 'Desert Eagle',
  hegrenade: 'HE Grenade',
  smokegrenade: 'Smoke',
  mp5navy: 'MP5',
  elite: 'Dual Elites',
  fiveseven: 'Five-SeveN',
  m249: 'M249',
  sg552: 'SG 552',
  sg550: 'SG 550',
};

const hud = document.getElementById('hud')!;
const killfeed = document.getElementById('hud-killfeed')!;
const chatFeed = document.getElementById('hud-chat')!;
const health = document.getElementById('hud-health')!;
const healthValue = document.getElementById('hud-health-value')!;
const armor = document.getElementById('hud-armor')!;
const armorValue = document.getElementById('hud-armor-value')!;
const helmet = document.getElementById('hud-helmet')!;
const timer = document.getElementById('hud-timer')!;
const timerValue = document.getElementById('hud-timer-value')!;
const money = document.getElementById('hud-money')!;
const moneyValue = document.getElementById('hud-money-value')!;
const moneyDelta = document.getElementById('hud-money-delta')!;
const ammo = document.getElementById('hud-ammo')!;
const weaponName = document.getElementById('hud-weapon')!;
const clip = document.getElementById('hud-clip')!;
const reserve = document.getElementById('hud-reserve')!;
const scoreboard = document.getElementById('hud-scoreboard')!;
const sbServer = document.getElementById('sb-server')!;
const sbMap = document.getElementById('sb-map')!;
const sbTeams = {
  CT: {
    meta: document.getElementById('sb-ct-meta')!,
    score: document.getElementById('sb-ct-score')!,
    rows: document.getElementById('sb-ct-rows')!,
  },
  T: {
    meta: document.getElementById('sb-t-meta')!,
    score: document.getElementById('sb-t-score')!,
    rows: document.getElementById('sb-t-rows')!,
  },
};
const sbSpectators = document.getElementById('sb-spectators')!;
const sbSpectatorNames = document.getElementById('sb-spectator-names')!;
const sbSession = document.getElementById('sb-session')!;
const sbSessionStats = document.getElementById('sb-session-stats')!;
const sbChat = document.getElementById('sb-chat')!;
const toastText = document.getElementById('hud-toast-text')!;
const levelToastText = document.getElementById('hud-level-toast-text')!;
const gg = document.getElementById('hud-gg')!;
const ggLevel = document.getElementById('hud-gg-level')!;
const ggWeapon = document.getElementById('hud-gg-weapon')!;
const ggNext = document.getElementById('hud-gg-next')!;
const ggLeader = document.getElementById('hud-gg-leader')!;
const ggWinner = document.getElementById('hud-gg-winner')!;
const protect = document.getElementById('hud-protect')!;
const protectFill = document.getElementById('hud-protect-fill')!;
const roundBanner = document.getElementById('hud-round')!;
const roundBannerTitle = document.getElementById('hud-round-title')!;
const roundBannerReason = document.getElementById('hud-round-reason')!;
const roundBannerScore = document.getElementById('hud-round-score')!;
const roundBannerMvp = document.getElementById('hud-round-mvp')!;
const summary = document.getElementById('hud-summary')!;
const summaryResult = document.getElementById('sum-result')!;
const summaryMap = document.getElementById('sum-map')!;
const summaryMvp = document.getElementById('sum-mvp')!;
const summaryRowsEl = document.getElementById('sum-rows')!;
const summaryNext = document.getElementById('sum-next')!;
const NEXT_MAP_UNKNOWN = 'The next map loads in a few seconds.';

const headshotIcon = document.createElementNS(
  'http://www.w3.org/2000/svg',
  'svg'
);
headshotIcon.setAttribute('class', 'hud-icon');
headshotIcon.setAttribute('viewBox', '0 0 24 24');
headshotIcon.innerHTML =
  '<path fill-rule="evenodd" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm0 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/>';

function icon(className: string, path: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.innerHTML = `<path d="${path}"/>`;
  return svg;
}

const deadIcon = icon(
  'sb-icon dead',
  'M12 2a9 9 0 0 0-9 9c0 3 1.5 5.3 3.5 6.6V21h3v-2h1v2h3v-2h1v2h3v-3.4c2-1.3 3.5-3.6 3.5-6.6a9 9 0 0 0-9-9zm-3.5 8a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4z'
);
const bombIcon = icon(
  'sb-icon bomb',
  'M4 7h16v12H4zm2 2v8h12V9zm1 1h4v2H7zm6 0h4v2h-4zm-6 3h10v3H7zM9 3h6v4h-2V5h-2v2H9z'
);
const vipIcon = icon(
  'sb-icon vip',
  'M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5zm3 14h12v2H6z'
);

// Largest clip seen per weapon, used as its magazine size for low ammo.
const maxClip = new Map<string, number>();

type Timers = Set<ReturnType<typeof setTimeout>>;

const killTimers: Timers = new Set();
const chatTimers: Timers = new Set();
// Last chat lines, oldest first; drawn in #sb-chat only while the scoreboard
// is open. The live feed keeps its own elements and timers.
const chatHistory: ChatLine[] = [];

let engine: Xash3D | undefined;
let bridgeSeen = false;
// Who asked for live scores (setLiveScores).
const liveScoreUsers = new Set<string>();
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
// The first money change after a reset is the server syncing the balance
// (+$800 on connect, the new map's start money), not a purchase or reward.
let moneySynced = false;
// Last rendered scores, to skip identical snapshots (sent at 2 Hz).
let lastScores = '';
const eventListeners = new Set<(event: HudEvent) => void>();
// Kills, deaths and streaks per player since the last reset (map change or
// reconnect); see stats.ts.
const sessionStats = createSessionStats();
let lastSession = '';
const roundStarts = createRoundStartDetector();
let roundBannerTimer: ReturnType<typeof setTimeout> | undefined;
let latestScores: Scores | undefined;
// Fills each scoreboard row's voice cell (voice-hud.ts).
let scoreVoice: ((player: ScorePlayer, cell: HTMLElement) => void) | undefined;
let summaryMapName = '';
let lastSummary = '';
let nextMapRequest = 0;
// Last `mode` event (Gun Game / Deathmatch), undefined in classic.
let modeState: ModeState | undefined;
let protectTimer: ReturnType<typeof setTimeout> | undefined;
// Announcer triggers (first blood, last man...) per round; see
// announcer-rules.ts.
const announcer = createAnnouncerTriggers();
let lobbyModeRequest = 0;
// The game client forwards the server's WcMode message (cs16-client
// 0.0.10+): tell the server, so it stops drawing its own HUD message.
const modeEventSupported = versionAtLeast(
  __CS16_CLIENT_VERSION__,
  MODE_EVENT_CLIENT_VERSION
);

/** Session stats counted from the kill feed (cleared on every reset event). */
export function getSessionStats() {
  return sessionStats;
}

/**
 * The name the local player connects with, used to spot its kills until a
 * scores snapshot gives the name the server actually uses.
 */
export function setLocalPlayerName(name: string): void {
  sessionStats.setLocalName(name);
}

/**
 * Calls listener with every bridge event, after the HUD has handled it. A
 * reset event means InitHUD: a map change or reconnect. Returns a function
 * that removes it.
 */
export function onHudEvent(listener: (event: HudEvent) => void): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

/**
 * True while the HTML HUD is in use: the client has sent a bridge event
 * (hud_html 1 on a cs16-client with the bridge) and the HUD is shown.
 */
export function isHudActive(): boolean {
  return bridgeSeen && !hud.hidden;
}

/** True while the scoreboard (Tab) is shown. */
export function isScoreboardOpen(): boolean {
  return !scoreboard.hidden;
}

/** The last scores snapshot since the last reset, if any. */
export function getLatestScores(): Scores | undefined {
  return latestScores;
}

/**
 * Sets what goes in each scoreboard row's voice cell (between the name and
 * the kills; spectators get one after their name) and redraws.
 */
export function setScoreVoice(
  fill: (player: ScorePlayer, cell: HTMLElement) => void
): void {
  scoreVoice = fill;
  redrawScores();
}

/** Redraws the scoreboard from the last snapshot (e.g. the voice cells). */
export function redrawScores(): void {
  lastScores = '';
  if (latestScores) renderScores(latestScores);
}

/** True while the main menu (mainui, drawn in the canvas) is open. */
export function isMenuOpen(): boolean {
  return hud.classList.contains('menu-open');
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function setHidden(el: HTMLElement, hidden: boolean): void {
  if (el.hidden !== hidden) el.hidden = hidden;
}

function weaponLabel(name: string): string {
  return WEAPON_NAMES[name] ?? name;
}

function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function teamClass(team: Team): string {
  return team === 'CT' ? 'ct' : team === 'T' ? 't' : '';
}

function killName(name: string, team: Team): HTMLElement {
  const el = document.createElement('span');
  el.className = `hud-kill-name ${teamClass(team)}`;
  el.textContent = name;
  return el;
}

function later(timers: Timers, fn: () => void, ms: number): void {
  const id = setTimeout(() => {
    timers.delete(id);
    fn();
  }, ms);
  timers.add(id);
}

function addKill(kill: Extract<HudEvent, { type: 'kill' }>['payload']): void {
  const row = document.createElement('div');
  row.className = 'hud-kill';
  // An empty killer is a suicide or world kill: only the victim is shown.
  if (kill.killer) row.append(killName(kill.killer, kill.killerTeam));
  const weapon = document.createElement('span');
  weapon.className = 'hud-kill-weapon';
  weapon.textContent = weaponLabel(kill.weapon);
  row.append(weapon);
  if (kill.headshot) row.append(headshotIcon.cloneNode(true));
  row.append(killName(kill.victim, kill.victimTeam));

  killfeed.append(row);
  while (killfeed.childElementCount > MAX_KILLS) {
    killfeed.firstElementChild!.remove();
  }
  later(
    killTimers,
    () => {
      row.classList.add('fading');
      later(killTimers, () => row.remove(), KILL_FADE_MS);
    },
    KILL_TTL_MS
  );
}

function chatPart(className: string, text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

function chatName(name: string, team: ChatLine['team']): HTMLElement {
  const color = team === 'CT' || team === 'T' ? teamClass(team) : 'spec';
  return chatPart(`hud-chat-name ${color}`, name);
}

/**
 * Builds one chat line: tags, name, location and message. Player text only
 * goes in through textContent. Used by the feed and the history panel.
 */
function chatLine(line: ChatLine): HTMLElement {
  const row = document.createElement('div');
  row.className = `hud-chat-line ${line.kind}`;
  if (line.kind === 'notice') {
    row.append(chatPart('hud-chat-text', line.text));
    return row;
  }
  if (line.kind === 'name') {
    row.append(
      chatName(line.name, line.team),
      ' is now ',
      chatName(line.text, line.team)
    );
    return row;
  }

  // Spectators are dead too; the stock chat shows only *SPEC* for them.
  // Radio always reaches teammates only, so it gets RADIO and no TEAM.
  const tags: string[] = [];
  if (line.dead && line.team !== 'SPEC') tags.push('Dead');
  if (line.team === 'SPEC') tags.push('Spec');
  if (line.teamOnly && line.kind !== 'radio') tags.push('Team');
  if (line.kind === 'radio') tags.push('Radio');
  for (const tag of tags) row.append(chatPart('hud-chat-tag', tag), ' ');

  row.append(chatName(line.name, line.team));
  if (line.location) {
    row.append(' ', chatPart('hud-chat-loc', `@ ${line.location}`));
  }
  row.append(': ', chatPart('hud-chat-text', line.text));
  return row;
}

function addChat(line: ChatLine): void {
  const row = chatLine(line);
  chatFeed.append(row);
  while (chatFeed.childElementCount > MAX_CHAT) {
    chatFeed.firstElementChild!.remove();
  }
  later(
    chatTimers,
    () => {
      row.classList.add('fading');
      later(chatTimers, () => row.remove(), CHAT_FADE_MS);
    },
    CHAT_TTL_MS
  );
  addChatHistory(line);
}

function addChatHistory(line: ChatLine): void {
  chatHistory.push(line);
  if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.shift();
  if (scoreboard.hidden) return;
  sbChat.append(chatLine(line));
  while (sbChat.childElementCount > MAX_CHAT_HISTORY) {
    sbChat.firstElementChild!.remove();
  }
  showChatHistory();
}

/** Shows #sb-chat when it has lines, scrolled to the newest (at the bottom). */
function showChatHistory(): void {
  setHidden(sbChat, sbChat.childElementCount === 0);
  sbChat.scrollTop = sbChat.scrollHeight;
}

function showToast(text: string): void {
  toastText.textContent = text;
  toastText.classList.remove('show');
  // Restart the animation when toasts arrive back to back.
  void toastText.offsetWidth;
  toastText.classList.add('show');
}

function showLevelToast(text: string): void {
  levelToastText.textContent = text;
  levelToastText.classList.remove('show');
  void levelToastText.offsetWidth;
  levelToastText.classList.add('show');
}

function hideProtection(): void {
  clearTimeout(protectTimer);
  protectTimer = undefined;
  setHidden(protect, true);
}

/** The bar empties over `ms`, then hides (or earlier, on a new event). */
function showProtection(ms: number): void {
  clearTimeout(protectTimer);
  protectFill.style.transition = 'none';
  protectFill.style.transform = 'scaleX(1)';
  setHidden(protect, false);
  // Start the transition from full after the reset above is applied.
  void protectFill.offsetWidth;
  protectFill.style.transition = `transform ${ms}ms linear`;
  protectFill.style.transform = 'scaleX(0)';
  protectTimer = setTimeout(hideProtection, ms);
}

function renderMode(state: ModeState): void {
  const toast = levelToast(modeState, state);
  if (toast) showLevelToast(toast);
  const sound = modeSound(modeState, state);
  if (sound) announce(sound);
  announcer.setGameMode(state.mode);
  modeState = state.mode === 0 ? undefined : state;

  setHidden(gg, !isGunGame(modeState));
  hud.classList.toggle('gun-game', isGunGame(modeState));
  if (isGunGame(modeState)) {
    const strip = gunGameStrip(modeState);
    setText(ggLevel, strip.level);
    setText(ggWeapon, strip.weapon);
    setText(ggNext, strip.next);
    setHidden(ggNext, !strip.next);
    setText(ggLeader, strip.leader);
    setHidden(ggLeader, !strip.leader || !!strip.winner);
    setText(ggWinner, strip.winner);
    setHidden(ggWinner, !strip.winner);
  }

  if (state.protection > 0) showProtection(state.protection);
  else hideProtection();
}

function onKillCounted(kill: KillEvent, result: KillResult): void {
  const multiKill = result.local?.multiKill;
  if (multiKill && getSettings().killStreakToasts) showToast(multiKill.label);
  const call = announcer.kill(
    kill,
    result,
    sessionStats.localName(),
    getAnnouncerOptions()
  );
  if (call.firstBlood) showToast(`${call.firstBlood} drew first blood`);
  if (call.otherStreak && getSettings().killStreakToasts) {
    showToast(call.otherStreak);
  }
  if (call.sound) announce(call.sound);
  renderSession();
}

/** Last man standing, checked on each scores snapshot. */
function announceScores(scores: Scores): void {
  const sound = announcer.scores(scores.players);
  if (sound) announce(sound);
}

/**
 * Before cs16-client 0.0.10 the page gets no `mode` event, so the game mode
 * for the announcer (first blood and last man per map in Gun Game and
 * Deathmatch) comes from /status.json, asked at each map and round start.
 */
function refreshAnnouncerMode(): void {
  if (modeEventSupported) return;
  const request = ++lobbyModeRequest;
  void fetchLobbyStatus().then((status) => {
    if (request !== lobbyModeRequest || !status) return;
    announcer.setGameMode(status.gameMode);
  });
}

function renderSession(): void {
  const stats = sessionStats.local();
  const key = stats
    ? [stats.kills, stats.deaths, stats.headshots, stats.bestStreak].join()
    : '';
  if (key === lastSession) return;
  lastSession = key;
  setHidden(sbSession, !stats);
  if (!stats) return;
  const items: [string, string][] = [
    ['K', String(stats.kills)],
    ['D', String(stats.deaths)],
    ['K/D', formatKd(stats)],
    ['HS', formatHeadshots(stats)],
    ['Best streak', String(stats.bestStreak)],
  ];
  sbSessionStats.replaceChildren(
    ...items.map(([label, value]) => {
      const item = document.createElement('span');
      item.className = 'sb-session-item';
      const name = document.createElement('span');
      name.className = 'sb-session-name';
      name.textContent = label;
      item.append(name, ` ${value}`);
      return item;
    })
  );
}

function flashMoney(delta: number): void {
  moneyDelta.textContent = `${delta > 0 ? '+' : '-'}$${Math.abs(delta)}`;
  moneyDelta.classList.remove('gain', 'loss');
  // Restart the animation when deltas arrive back to back.
  void moneyDelta.offsetWidth;
  moneyDelta.classList.add(delta > 0 ? 'gain' : 'loss');
}

function setWeapon(name: string, clipValue: number, reserveValue: number) {
  setHidden(ammo, name === '');
  setText(weaponName, weaponLabel(name));

  setHidden(clip, clipValue < 0);
  setText(clip, String(clipValue));
  setHidden(reserve, reserveValue < 0);
  setText(reserve, String(reserveValue));

  let low = false;
  if (clipValue >= 0) {
    const size = Math.max(maxClip.get(name) ?? 0, clipValue);
    maxClip.set(name, size);
    low = clipValue <= Math.floor(size / 4);
  }
  ammo.classList.toggle('low', low);
}

function byScore(a: ScorePlayer, b: ScorePlayer): number {
  return b.frags - a.frags || a.deaths - b.deaths || a.id - b.id;
}

function scoreRow(player: ScorePlayer): HTMLElement {
  const row = document.createElement('div');
  row.className = 'sb-row';
  if (player.dead) row.classList.add('dead');
  if (player.local) row.classList.add('local');

  const status = document.createElement('span');
  status.className = 'sb-status';
  if (player.dead) status.append(deadIcon.cloneNode(true));
  else if (player.bomb) status.append(bombIcon.cloneNode(true));
  else if (player.vip) status.append(vipIcon.cloneNode(true));

  const name = document.createElement('span');
  name.className = 'sb-name';
  name.textContent = player.name;

  const voice = document.createElement('span');
  voice.className = 'sb-voice';
  scoreVoice?.(player, voice);

  const cells = [player.frags, player.deaths].map((value) => {
    const cell = document.createElement('span');
    cell.textContent = String(value);
    return cell;
  });

  const ping = document.createElement('span');
  ping.textContent = player.bot ? 'BOT' : String(player.ping);

  row.append(status, name, voice, ...cells, ping);
  return row;
}

function renderScores(scores: Scores): void {
  // Identical snapshots are common at 2 Hz; skip them without touching the DOM.
  const key = JSON.stringify(scores);
  if (key === lastScores) return;
  lastScores = key;

  setText(sbServer, scores.server);
  setText(sbMap, scores.map);

  const sorted = [...scores.players].sort(byScore);
  for (const team of ['CT', 'T'] as const) {
    const info = scores.teams[team];
    const els = sbTeams[team];
    setText(els.score, String(info.score));
    setText(
      els.meta,
      `${info.players} ${info.players === 1 ? 'player' : 'players'} · ${
        info.avgPing
      } ms`
    );
    // Rows are built off-document and swapped in with one DOM write.
    const rows = document.createDocumentFragment();
    for (const player of sorted) {
      if (player.team === team) rows.append(scoreRow(player));
    }
    els.rows.replaceChildren(rows);
  }

  const spectators = sorted.filter((p) => p.team !== 'CT' && p.team !== 'T');
  setHidden(sbSpectators, spectators.length === 0);
  sbSpectatorNames.replaceChildren(
    ...spectators.map((player) => {
      const el = document.createElement('span');
      el.className = player.local ? 'sb-spectator local' : 'sb-spectator';
      const name = document.createElement('span');
      name.className = 'sb-spectator-name';
      name.textContent = player.name;
      const voice = document.createElement('span');
      voice.className = 'sb-voice';
      scoreVoice?.(player, voice);
      el.append(name, voice);
      return el;
    })
  );
}

function hideRoundBanner(): void {
  clearTimeout(roundBannerTimer);
  roundBannerTimer = undefined;
  setHidden(roundBanner, true);
}

function showRoundBanner(end: RoundEnd): void {
  if (!summary.hidden) return;
  const winner = end.winner === 'CT' || end.winner === 'T' ? end.winner : '';
  roundBanner.className = `hud-round ${teamClass(winner)}`;
  setText(roundBannerTitle, roundTitle(end));
  const reason = roundReasonText(end);
  setText(roundBannerReason, reason);
  setHidden(roundBannerReason, !reason);
  const score = roundScoreText(end);
  setText(roundBannerScore, score);
  setHidden(roundBannerScore, !score);
  const mvp =
    end.reason === 'commencing' ? undefined : pickRoundMvp(sessionStats.all());
  roundBannerMvp.replaceChildren();
  if (mvp) {
    const label = document.createElement('span');
    label.className = 'hud-round-mvp-label';
    label.textContent = 'MVP';
    const name = document.createElement('span');
    name.className = 'hud-round-mvp-name';
    name.textContent = mvp.name;
    roundBannerMvp.append(label, name, ` ${killsText(mvp.round.kills)}`);
  }
  setHidden(roundBannerMvp, !mvp);
  setHidden(roundBanner, false);
  clearTimeout(roundBannerTimer);
  roundBannerTimer = setTimeout(hideRoundBanner, ROUND_BANNER_MS);
}

function summaryCell(text: string, className?: string): HTMLElement {
  const cell = document.createElement('span');
  if (className) cell.className = className;
  cell.textContent = text;
  return cell;
}

function renderSummary(): void {
  const stats = sessionStats.all();
  const players = latestScores?.players ?? [];
  const rows = summaryRows(players, stats);
  const map = latestScores?.map || summaryMapName;
  const teams = latestScores?.teams;
  const key = JSON.stringify([map, teams?.CT.score, teams?.T.score, rows]);
  if (key === lastSummary) return;
  lastSummary = key;

  setText(summaryMap, map);
  setText(
    summaryResult,
    teams ? mapResultText(teams.CT.score, teams.T.score) : ''
  );
  const mvp = pickMapMvp(stats);
  summaryMvp.replaceChildren();
  if (mvp) {
    const label = document.createElement('span');
    label.className = 'sum-mvp-label';
    label.textContent = 'Map MVP';
    const name = document.createElement('span');
    name.className = 'sum-mvp-name';
    name.textContent = mvp.name;
    summaryMvp.append(
      label,
      name,
      ` ${killsText(mvp.kills)} · ${formatHeadshots(mvp)} HS`
    );
  }
  setHidden(summaryMvp, !mvp);

  summaryRowsEl.replaceChildren(
    ...rows.map((row) => {
      const el = document.createElement('div');
      el.className = 'sum-row';
      if (row.local) el.classList.add('local');
      if (row.frags === null) el.classList.add('left');
      const team = row.team === 'CT' || row.team === 'T' ? row.team : '';
      const name = summaryCell(row.name, `sum-name ${teamClass(team)}`);
      if (team) name.title = TEAM_NAMES[team];
      el.append(
        name,
        summaryCell(row.frags === null ? 'left' : String(row.frags)),
        summaryCell(String(row.kills)),
        summaryCell(String(row.deaths)),
        summaryCell(formatHeadshots(row)),
        summaryCell(String(row.bestStreak))
      );
      return el;
    })
  );
}

function showSummary(event: Intermission): void {
  if (!event.active) {
    hideSummary();
    return;
  }
  summaryMapName = event.map;
  hideRoundBanner();
  lastSummary = '';
  renderSummary();
  setHidden(summary, false);
  hud.classList.add('summary-open');
  showNextMap(event.map);
}

/**
 * The next map is a server cvar (amx_nextmap) the game client can't read;
 * the server's /status.json has it. Only trusted while the server is still
 * on the map that just ended.
 */
function showNextMap(map: string): void {
  const request = ++nextMapRequest;
  summaryNext.textContent = NEXT_MAP_UNKNOWN;
  void fetchLobbyStatus().then((status) => {
    if (request !== nextMapRequest || summary.hidden) return;
    if (!status?.nextMap || status.map !== map) return;
    summaryNext.textContent = `Next map: ${status.nextMap}.`;
  });
}

function hideSummary(): void {
  nextMapRequest++;
  setHidden(summary, true);
  hud.classList.remove('summary-open');
  summaryRowsEl.replaceChildren();
  lastSummary = '';
}

function showScoreboard(visible: boolean): void {
  if (visible === !scoreboard.hidden) return;
  setHidden(scoreboard, !visible);
  hud.classList.toggle('scores-open', visible);
  // The history is rebuilt on each open and dropped on close, so the 50
  // lines are only in the page while Tab is held.
  sbChat.replaceChildren(...(visible ? chatHistory.map(chatLine) : []));
  showChatHistory();
}

function reset(): void {
  for (const el of [health, armor, helmet, timer, money, ammo]) {
    setHidden(el, true);
  }
  timer.classList.remove('planted', 'panic');
  moneyDelta.classList.remove('gain', 'loss');
  moneySynced = false;
  for (const id of killTimers) clearTimeout(id);
  killTimers.clear();
  killfeed.replaceChildren();
  for (const id of chatTimers) clearTimeout(id);
  chatTimers.clear();
  chatFeed.replaceChildren();
  chatHistory.length = 0;
  maxClip.clear();
  showScoreboard(false);
  lastScores = '';
  toastText.classList.remove('show');
  levelToastText.classList.remove('show');
  modeState = undefined;
  setHidden(gg, true);
  hud.classList.remove('gun-game');
  hideProtection();
  hideRoundBanner();
  hideSummary();
  roundStarts.reset();
  latestScores = undefined;
  sessionStats.reset();
  renderSession();
  announcer.reset();
  // A new map starts without a mode until the plugin sends one.
  if (modeEventSupported) announcer.setGameMode(0);
  // Vitals and ammo stay hidden until the first alive event (sent the frame
  // after connect, or right after a reset's resend), so a player joining
  // mid-round as a spectator never sees them flash.
  hud.dataset.alive = 'unknown';
  delete hud.dataset.spectating;
}

function handle(event: HudEvent): void {
  switch (event.type) {
    case 'health': {
      const { hp } = event.payload;
      setHidden(health, false);
      setText(healthValue, String(hp));
      health.classList.toggle('low', hp < LOW_HEALTH);
      break;
    }
    case 'armor': {
      setHidden(armor, false);
      setText(armorValue, String(event.payload.ap));
      setHidden(helmet, !event.payload.helmet);
      break;
    }
    case 'money': {
      const { amount, delta } = event.payload;
      setHidden(money, false);
      setText(moneyValue, amount.toLocaleString('en-US'));
      // delta is 0 when the client resends the last value.
      if (delta !== 0 && moneySynced) flashMoney(delta);
      if (delta !== 0) moneySynced = true;
      break;
    }
    case 'weapon': {
      const { name, clip, reserve } = event.payload;
      setWeapon(name, clip, reserve);
      break;
    }
    case 'timer': {
      const { seconds, bombPlanted } = event.payload;
      setHidden(timer, false);
      setText(timerValue, formatTime(seconds));
      timer.classList.toggle('planted', bombPlanted);
      timer.classList.toggle('panic', seconds <= PANIC_SECONDS);
      if (roundStarts.timer(seconds)) {
        sessionStats.startRound();
        hideRoundBanner();
        announcer.roundStart();
        refreshAnnouncerMode();
      }
      break;
    }
    case 'kill': {
      addKill(event.payload);
      onKillCounted(
        event.payload,
        sessionStats.recordKill(event.payload, performance.now())
      );
      break;
    }
    case 'chat':
      addChat(event.payload);
      break;
    case 'alive': {
      const { alive, spectating } = event.payload;
      // Health and armor still describe the local player while spectating.
      const shown = alive && !spectating ? 'true' : 'false';
      if (hud.dataset.alive !== shown) hud.dataset.alive = shown;
      // The engine draws its spectator bars then (see .hud-killcard).
      const spec = String(spectating);
      if (hud.dataset.spectating !== spec) hud.dataset.spectating = spec;
      break;
    }
    case 'reset':
      reset();
      refreshAnnouncerMode();
      break;
    case 'round':
      showRoundBanner(event.payload);
      break;
    case 'intermission':
      showSummary(event.payload);
      break;
    case 'scoreboard':
      showScoreboard(event.payload.visible);
      break;
    case 'scores':
      renderScores(event.payload);
      sessionStats.updatePlayers(event.payload.players);
      renderSession();
      announceScores(event.payload);
      latestScores = event.payload;
      if (!summary.hidden) renderSummary();
      break;
    case 'menu':
      // The menu is drawn inside the canvas, so the overlay would cover it.
      hud.classList.toggle('menu-open', event.payload.visible);
      break;
    case 'mode':
      renderMode(parseModeState(event.payload));
      break;
  }
}

// engine.em is a wrapper ({ Module, FS, HEAPU8, ... }); the client's EM_JS
// code reads hudEvent from the Emscripten Module inside it.
function bridgeModule(target: Xash3D): HudModule {
  return target.em!.Module as HudModule;
}

/**
 * Asks the client to send `scores` every 0.5 s even while the scoreboard is
 * hidden (cvar hud_html_scores, cs16-client 0.0.6+; older builds ignore it).
 * Each user (e.g. an admin tab) turns it on and off under its own name; it
 * stays on while any user wants it, and across a reconnect.
 */
export function setLiveScores(user: string, enabled: boolean): void {
  if (enabled) liveScoreUsers.add(user);
  else liveScoreUsers.delete(user);
  sendLiveScores();
}

function sendLiveScores(): void {
  engine?.Cmd_ExecuteString(
    `hud_html_scores ${liveScoreUsers.size > 0 ? 1 : 0}`
  );
}

function setHudEnabled(enabled: boolean): void {
  hud.hidden = !enabled;
  engine?.Cmd_ExecuteString(`hud_html ${enabled ? 1 : 0}`);
  // Userinfo for the game mode plugin: with 1 it sends WcMode (the `mode`
  // event) instead of drawing its HUD message; wc_killinfo also sends
  // WcKillInfo (the `killinfo` event, same client release) only then. Set before connecting, and
  // sent to the server again when it changes. Older clients never set it,
  // so the plugin keeps drawing for them.
  if (modeEventSupported) {
    engine?.Cmd_ExecuteString(`setinfo wc_html_hud ${enabled ? 1 : 0}`);
  }
}

function onBridgeEvent(type: string, payload: unknown): void {
  if (!bridgeSeen) {
    bridgeSeen = true;
    clearTimeout(fallbackTimer);
    // Events can still show up after a slow connect fell back.
    if (hud.hidden) setHudEnabled(true);
  }
  const event = { type, payload } as HudEvent;
  handle(event);
  for (const listener of eventListeners) listener(event);
}

/**
 * Shows the HTML HUD and hides the stock elements it replaces. Call after
 * engine.main() and before connecting, so no bridge event is missed.
 */
export function attachHud(target: Xash3D): void {
  detachHud();
  engine = target;
  bridgeModule(target).hudEvent = onBridgeEvent;
  setHudEnabled(true);
  // A new engine starts with the cvar off.
  if (liveScoreUsers.size > 0) sendLiveScores();
  fallbackTimer = setTimeout(() => {
    if (!bridgeSeen) setHudEnabled(false);
  }, FALLBACK_MS);
}

/** Hides the HUD and stops all its timers (connection lost). */
export function detachHud(): void {
  if (!engine) return;
  delete bridgeModule(engine).hudEvent;
  engine = undefined;
  bridgeSeen = false;
  clearTimeout(fallbackTimer);
  reset();
  hud.classList.remove('menu-open');
  hud.hidden = true;
}
