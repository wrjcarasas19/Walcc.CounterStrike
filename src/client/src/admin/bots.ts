import { onHudEvent, setLiveScores, type HudEvent, type Scores } from '../hud';
import {
  BOT_QUOTA_MAX,
  DEFAULT_DIFFICULTY,
  DIFFICULTIES,
  isDifficulty,
  parseBotQuota,
  type BotTeam,
} from './bot-commands';
import {
  expectEffect,
  hasPassword,
  isBusy,
  sendAction,
  setStatus,
  type AdminAction,
  type AdminTab,
} from './core';

// YaPB bots: add to a team, kick, difficulty and a "fill to N players"
// quota. Adding and kicking are confirmed by the bot count in `scores`
// snapshots (sent every 0.5 s while the tab is shown, see setLiveScores);
// the settings have no HUD event, so they only show "Sent".

// YaPB adds bots from a queue, and waits yb_join_delay (5 s) after a map
// change; the rest covers the connect and the 0.5 s snapshot interval.
const ADD_TIMEOUT_MS = 15_000;
// Kicks happen on the server's next frame.
const KICK_TIMEOUT_MS = 5_000;
const LIVE_SCORES_USER = 'admin-bots';

type BotCounts = { CT: number; T: number; total: number };

const panel = document.createElement('div');
panel.className = 'admin-tab-body';

function buttonGroup(
  id: string,
  title: string,
  buttons: HTMLButtonElement[]
): HTMLElement {
  const group = document.createElement('div');
  group.className = 'field';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-labelledby', id);
  const label = document.createElement('span');
  label.className = 'field-label';
  label.id = id;
  label.textContent = title;
  const row = document.createElement('div');
  row.className = 'admin-presets';
  row.append(...buttons);
  group.append(label, row);
  return group;
}

function secondaryButton(text: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'action-button admin-secondary';
  button.type = 'button';
  button.disabled = true;
  button.textContent = text;
  return button;
}

const countNote = document.createElement('p');
countNote.className = 'admin-note';
countNote.setAttribute('aria-live', 'polite');

const addButtons: Record<BotTeam, HTMLButtonElement> = {
  CT: secondaryButton('Add CT bot'),
  T: secondaryButton('Add T bot'),
};
const kickButton = secondaryButton('Kick a bot');
const kickAllButton = secondaryButton('Kick all bots');

const grid = document.createElement('div');
grid.className = 'admin-cvars';

const difficultyField = document.createElement('div');
difficultyField.className = 'field';
const difficultyLabel = document.createElement('label');
difficultyLabel.className = 'field-label';
difficultyLabel.htmlFor = 'admin-bot-difficulty';
difficultyLabel.textContent = 'Difficulty';
const difficultyInput = document.createElement('select');
difficultyInput.id = difficultyLabel.htmlFor;
difficultyInput.className = 'field-input';
difficultyInput.append(new Option('Unchanged', ''));
for (const { level, label } of DIFFICULTIES) {
  const text = level === DEFAULT_DIFFICULTY ? `${label} (default)` : label;
  difficultyInput.append(new Option(`${level} · ${text}`, String(level)));
}
const difficultyHint = document.createElement('span');
difficultyHint.className = 'admin-cvar-hint';
difficultyHint.id = `${difficultyInput.id}-hint`;
difficultyInput.setAttribute('aria-describedby', difficultyHint.id);
difficultyField.append(difficultyLabel, difficultyInput, difficultyHint);

const quotaField = document.createElement('div');
quotaField.className = 'field';
const quotaLabel = document.createElement('label');
quotaLabel.className = 'field-label';
quotaLabel.htmlFor = 'admin-bot-quota';
quotaLabel.textContent = 'Fill to N players';
const quotaInput = document.createElement('input');
quotaInput.type = 'text';
quotaInput.inputMode = 'numeric';
quotaInput.autocomplete = 'off';
quotaInput.maxLength = 2;
quotaInput.placeholder = `0-${BOT_QUOTA_MAX}`;
quotaInput.id = quotaLabel.htmlFor;
quotaInput.className = 'field-input';
const quotaHint = document.createElement('span');
quotaHint.className = 'admin-cvar-hint';
quotaHint.id = `${quotaInput.id}-hint`;
quotaInput.setAttribute('aria-describedby', quotaHint.id);
quotaField.append(quotaLabel, quotaInput, quotaHint);

grid.append(difficultyField, quotaField);

const settingsNote = document.createElement('p');
settingsNote.className = 'admin-note';
settingsNote.textContent =
  'Fill to N: bots join or leave so N players are in the teams, humans ' +
  'included (spectators not); 0 means no automatic bots. Adding or kicking ' +
  'a bot moves N by one, and Kick all sets it to 0. Difficulty also ' +
  'changes the bots already playing. Both stay across map changes.';

const apply = document.createElement('button');
apply.className = 'action-button';
apply.type = 'submit';
apply.disabled = true;
apply.textContent = 'Apply settings';

panel.append(
  countNote,
  buttonGroup('admin-bots-add-label', 'Add a bot', [
    addButtons.CT,
    addButtons.T,
  ]),
  buttonGroup('admin-bots-kick-label', 'Kick', [kickButton, kickAllButton]),
  grid,
  settingsNote,
  apply
);

// From the latest `scores` snapshot while the tab is shown (or an action
// waits); undefined until a fresh one arrives, so an old snapshot is never
// used to judge whether a bot joined.
let latest: Scores | undefined;
let shown = false;
// An add or kick waits for its effect.
let waiting = false;
// Last values sent this session, shown in the hints.
let sentDifficulty: number | undefined;
let sentQuota: number | undefined;

onHudEvent(trackEvent);
for (const input of [difficultyInput, quotaInput]) {
  input.addEventListener('input', () => {
    renderHints();
    refresh();
  });
}
addButtons.CT.addEventListener('click', () => void addBot('CT'));
addButtons.T.addEventListener('click', () => void addBot('T'));
kickButton.addEventListener('click', () => void kickBot());
kickAllButton.addEventListener('click', () => void kickAllBots());
renderHints();
renderCounts();

function trackEvent(event: HudEvent): void {
  if (event.type !== 'scores' || (!shown && !waiting)) return;
  latest = event.payload;
  renderCounts();
  // The kick buttons depend on whether there are bots.
  refresh();
}

function countBots(scores: Scores): BotCounts {
  const counts: BotCounts = { CT: 0, T: 0, total: 0 };
  for (const player of scores.players) {
    if (!player.bot) continue;
    counts.total += 1;
    if (player.team === 'CT' || player.team === 'T') counts[player.team] += 1;
  }
  return counts;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function renderCounts(): void {
  if (!latest) {
    countNote.textContent = 'Waiting for the player list from the game...';
    return;
  }
  const bots = countBots(latest);
  const humans = latest.players.length - bots.total;
  const text =
    bots.total === 0
      ? 'No bots'
      : `${plural(bots.total, 'bot')} (${bots.CT} CT, ${bots.T} T)`;
  const next = `${text} and ${plural(humans, 'player')}. Updates live.`;
  if (countNote.textContent !== next) countNote.textContent = next;
}

/** undefined: unchanged; otherwise the level. */
function readDifficulty(): number | undefined {
  if (difficultyInput.value === '') return undefined;
  const level = Number(difficultyInput.value);
  return isDifficulty(level) ? level : undefined;
}

/** undefined: left empty; otherwise the parsed value or the error. */
function readQuota(): ReturnType<typeof parseBotQuota> | undefined {
  if (quotaInput.value.trim() === '') return undefined;
  return parseBotQuota(quotaInput.value);
}

function difficultyText(level: number): string {
  const found = DIFFICULTIES.find((difficulty) => difficulty.level === level);
  return found ? `${level} · ${found.label}` : String(level);
}

function renderHints(): void {
  difficultyHint.textContent =
    sentDifficulty === undefined
      ? 'Applies now, to all bots'
      : `Applies now · Sent: ${difficultyText(sentDifficulty)}`;

  const parsed = readQuota();
  const invalid = parsed !== undefined && !parsed.ok;
  quotaInput.setAttribute('aria-invalid', String(invalid));
  quotaHint.classList.toggle('error', invalid);
  if (parsed && !parsed.ok) {
    quotaHint.textContent = parsed.error;
    return;
  }
  const parts = [`0-${BOT_QUOTA_MAX}, humans included`];
  if (sentQuota !== undefined) parts.push(`Sent: ${sentQuota}`);
  quotaHint.textContent = parts.join(' · ');
}

function refresh(): void {
  const blocked = isBusy() || !hasPassword();
  addButtons.CT.disabled = blocked;
  addButtons.T.disabled = blocked;
  const noBots = latest !== undefined && countBots(latest).total === 0;
  kickButton.disabled = blocked || noBots;
  kickAllButton.disabled = blocked || noBots;
  kickButton.title = noBots
    ? 'No bots on the server'
    : 'Kicks one bot, a dead one first';
  kickAllButton.title = noBots ? 'No bots on the server' : '';
  const quota = readQuota();
  const filled = readDifficulty() !== undefined || quota !== undefined;
  apply.disabled = blocked || !filled || (quota !== undefined && !quota.ok);
}

function updateLive(): void {
  setLiveScores(LIVE_SCORES_USER, shown || waiting);
}

/**
 * Sends the command and waits for a snapshot where check(counts before,
 * counts now) holds. Without a fresh snapshot to compare with it only says
 * "Sent".
 */
async function runAction(
  action: AdminAction,
  working: string,
  check: (before: BotCounts, now: BotCounts) => boolean,
  timeoutMs: number,
  done: string,
  failed: string
): Promise<void> {
  if (isBusy()) return;
  const before = latest ? countBots(latest) : undefined;
  if (!sendAction(action)) return;
  if (!before) {
    setStatus("Sent. The bot count isn't known yet, so it can't be checked.");
    return;
  }
  waiting = true;
  updateLive();
  setStatus(working);
  const result = await expectEffect(
    (event) =>
      event.type === 'scores' && check(before, countBots(event.payload)),
    timeoutMs
  );
  waiting = false;
  updateLive();
  if (result === 'done') setStatus(done);
  else if (result === 'timeout') setStatus(failed, true);
}

function addBot(team: BotTeam): Promise<void> {
  return runAction(
    { action: 'bot_add', team },
    `Adding a ${team} bot...`,
    (before, now) => now[team] > before[team],
    ADD_TIMEOUT_MS,
    `Done. A ${team} bot joined.`,
    `No ${team} bot joined. Check the password. The team may also be full ` +
      '(mp_limitteams): add a bot to the other team first.'
  );
}

function kickBot(): Promise<void> {
  return runAction(
    { action: 'bot_kick' },
    'Kicking a bot...',
    (before, now) => now.total < before.total,
    KICK_TIMEOUT_MS,
    'Done. A bot was kicked.',
    'No bot left the server. Check the password and try again.'
  );
}

function kickAllBots(): Promise<void> {
  return runAction(
    { action: 'bot_kick_all' },
    'Kicking all bots...',
    (_before, now) => now.total === 0,
    KICK_TIMEOUT_MS,
    'Done. All bots were kicked.',
    'Bots are still on the server. Check the password and try again.'
  );
}

function applySettings(): void {
  if (isBusy()) return;
  const difficulty = readDifficulty();
  const quota = readQuota();
  if (quota && !quota.ok) {
    setStatus(quota.error, true);
    quotaInput.focus();
    return;
  }
  const actions: AdminAction[] = [];
  if (difficulty !== undefined) {
    actions.push({ action: 'bot_difficulty', level: difficulty });
  }
  if (quota) actions.push({ action: 'bot_quota', players: quota.value });
  if (actions.length === 0) return;
  for (const action of actions) {
    if (!sendAction(action)) return;
  }
  if (difficulty !== undefined) {
    sentDifficulty = difficulty;
    difficultyInput.value = '';
  }
  if (quota) {
    sentQuota = quota.value;
    quotaInput.value = '';
  }
  renderHints();
  refresh();
  // Nothing on the HUD confirms a cvar, so this can't say "Done".
  setStatus(
    quota ? 'Sent. Bots join or leave over the next few seconds.' : 'Sent.'
  );
}

function show(): void {
  shown = true;
  // Only a snapshot from now on is trusted (see latest).
  if (!waiting) latest = undefined;
  renderCounts();
  updateLive();
  refresh();
}

function hide(): void {
  shown = false;
  updateLive();
}

export const botsTab: AdminTab = {
  id: 'bots',
  label: 'Bots',
  panel,
  show,
  hide,
  submit: applySettings,
  refresh,
  focusTarget: () => (addButtons.CT.disabled ? null : addButtons.CT),
};
