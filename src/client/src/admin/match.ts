import { onHudEvent, type HudEvent } from '../hud';
import { fetchLobbyStatus, gameModeName } from '../lobby';
import {
  expectEffect,
  hasPassword,
  type EffectResult,
  isBusy,
  sendAction,
  setStatus,
  type AdminTab,
} from './core';
import {
  CVARS,
  choiceName,
  choiceNames,
  cvarCommand,
  describeRange,
  formatCvarValue,
  parseCvarValue,
  type CvarDef,
  type CvarName,
} from './cvars';
import { getNextMap, onNextMapChange, refreshNextMap } from './map';
import {
  AFTER_FUN_MAP_VALUES,
  FUN_MAP_PREFIXES,
  FUN_MAP_VALUES,
  isFunMap,
  PRESETS,
  type Preset,
} from './presets';

// Match settings: game mode presets, one cvar per field, plus "Restart
// round". rcon has no reply and cvar changes have no HUD event, so settings
// only show "Sent". A restart (also the end of every preset) is confirmed by
// the round timer jumping.
//
// The game modes (wc_gamemode: Gun Game, Deathmatch) and the weapon modes
// (wc_weaponmode: knife only, pistols only) don't mix: the weapon mode
// plugin ignores wc_weaponmode while a game mode is on. So that the admin
// knows why, the tab doesn't send a weapon mode while it knows a game mode
// is on (from what it sent, or from /status.json when the tab is shown) and
// says so instead.

const FIELDS: readonly CvarName[] = [
  'mp_friendlyfire',
  'sv_voiceenable',
  'sv_alltalk',
  'mp_timelimit',
  'mp_roundtime',
  'mp_startmoney',
  'mp_freezetime',
  'mp_buytime',
  'mp_maxrounds',
  'wc_gamemode',
  'wc_dm_fraglimit',
  'wc_gg_kills_per_level',
  'wc_gg_suicide_penalty',
  'wc_gg_join_lowest',
  'wc_weaponmode',
];

// sendCvars only knows the fields above; catch a preset that sets another.
for (const { label, values } of PRESETS) {
  for (const name of Object.keys(values)) {
    if (!FIELDS.includes(name as CvarName)) {
      throw new Error(`Preset ${label} sets ${name}, which isn't in FIELDS.`);
    }
  }
}

// sv_restart 1 restarts after one second; the rest covers the round trip.
const RESTART_TIMEOUT_MS = 5_000;
// /status.json is cached for 2 s and the plugin reads the cvar once a
// second, so a status read this soon after sending wc_gamemode may be old.
const GAME_MODE_SETTLE_MS = 5_000;

const APPLIES_TEXT: Record<CvarDef['applies'], string> = {
  now: 'Applies now',
  'next round': 'Applies next round',
  restart: 'Applies on restart',
};

type Field = {
  def: CvarDef;
  input: HTMLInputElement | HTMLSelectElement;
  hint: HTMLElement;
  /** Last value sent this session, shown in the hint. */
  sent?: number;
};

const panel = document.createElement('div');
panel.className = 'admin-tab-body';

const presetGroup = document.createElement('div');
presetGroup.className = 'field';
presetGroup.setAttribute('role', 'group');
presetGroup.setAttribute('aria-labelledby', 'admin-presets-label');
const presetLabel = document.createElement('span');
presetLabel.className = 'field-label';
presetLabel.id = 'admin-presets-label';
presetLabel.textContent = 'Presets';
const presetRow = document.createElement('div');
presetRow.className = 'admin-presets';
const presetButtons = PRESETS.map((preset) => {
  const button = document.createElement('button');
  button.className = 'action-button admin-secondary';
  button.type = 'button';
  button.id = `admin-preset-${preset.id}`;
  button.disabled = true;
  button.textContent = preset.label;
  button.title = presetSummary(preset);
  button.addEventListener('click', () => void applyPreset(preset));
  presetRow.append(button);
  return button;
});
const presetNote = document.createElement('p');
presetNote.className = 'admin-note';
// Which game mode is on, and that the weapon modes are off during one.
const modeNote = document.createElement('p');
modeNote.className = 'admin-note';
modeNote.setAttribute('aria-live', 'polite');
presetGroup.append(presetLabel, presetRow, presetNote, modeNote);

const grid = document.createElement('div');
grid.className = 'admin-cvars';

const fields = FIELDS.map((name): Field => {
  const def = CVARS[name];
  const field = document.createElement('div');
  field.className = 'field';
  const label = document.createElement('label');
  label.className = 'field-label';
  label.htmlFor = `admin-cvar-${name}`;
  label.textContent = def.label;
  let input: HTMLInputElement | HTMLSelectElement;
  if (def.kind !== 'number') {
    const select = document.createElement('select');
    const options =
      def.kind === 'bool'
        ? [
            ['1', 'On'],
            ['0', 'Off'],
          ]
        : choiceNames(def).map((name, index) => [
            String(def.min + index),
            name.charAt(0).toUpperCase() + name.slice(1),
          ]);
    for (const [value, text] of [['', 'Unchanged'], ...options]) {
      select.append(new Option(text, value));
    }
    input = select;
  } else {
    const text = document.createElement('input');
    text.type = 'text';
    text.inputMode = def.decimals > 0 ? 'decimal' : 'numeric';
    text.autocomplete = 'off';
    text.maxLength = 8;
    text.placeholder = describeRange(def);
    input = text;
  }
  input.id = label.htmlFor;
  input.className = 'field-input';
  const hint = document.createElement('span');
  hint.className = 'admin-cvar-hint';
  hint.id = `${input.id}-hint`;
  input.setAttribute('aria-describedby', hint.id);
  field.append(label, input, hint);
  grid.append(field);
  return { def, input, hint };
});

const cfgNote = document.createElement('p');
cfgNote.className = 'admin-note';
cfgNote.textContent = `Reset on map change: ${fields
  .filter(({ def }) => def.mapReset !== undefined)
  .map(({ def }) => `${def.label} ${cfgText(def)}`)
  .join(', ')}.`;

// Fun maps run their own settings when they load (presets.ts).
const funMapNote = document.createElement('p');
funMapNote.className = 'admin-note';

const apply = document.createElement('button');
apply.className = 'action-button';
apply.type = 'submit';
apply.disabled = true;
apply.textContent = 'Apply settings';

const restart = document.createElement('button');
restart.className = 'action-button admin-secondary';
restart.type = 'button';
restart.disabled = true;
restart.textContent = 'Restart round';

panel.append(presetGroup, grid, cfgNote, funMapNote, apply, restart);

for (const field of fields) {
  field.input.addEventListener('input', () => {
    renderHint(field);
    refresh();
  });
  renderHint(field);
}
restart.addEventListener('click', () => void restartRound());

// The last round clock the HUD showed; undefined until the first timer event
// of a map.
let lastTimer: number | undefined;
// The last preset sent this session and what happened since.
let lastPreset:
  { preset: Preset; restart?: EffectResult; mapChanged: boolean } | undefined;
// wc_gamemode as far as this tab knows: undefined until read or sent.
let gameMode: number | undefined;
// When this session last sent wc_gamemode (Date.now()), 0 if never.
let gameModeSentAt = 0;
renderPresetNote();
renderModeNote();
renderFunMapNote();
onHudEvent(trackEvent);
onNextMapChange(renderFunMapNote);

function trackEvent(event: HudEvent): void {
  if (event.type === 'timer') lastTimer = event.payload.seconds;
  else if (event.type === 'reset') {
    lastTimer = undefined;
    if (lastPreset) lastPreset.mapChanged = true;
    renderPresetNote();
    // The game and weapon mode plugins have just put their values back.
    gameMode = CVARS.wc_gamemode.mapReset;
    renderModeNote();
    for (const field of fields) {
      if (field.def.mapReset !== undefined) field.sent = undefined;
      renderHint(field);
    }
  }
}

function cfgText(def: CvarDef): string {
  const value = def.mapReset!;
  if (def.kind === 'bool') return value ? 'on' : 'off';
  if (def.kind === 'choice') return choiceName(def, value);
  return `${formatCvarValue(def, value)}${def.unit ? ` ${def.unit}` : ''}`;
}

function valueText(def: CvarDef, value: number): string {
  if (def.kind === 'bool') return value ? 'on' : 'off';
  if (def.kind === 'choice') return choiceName(def, value);
  return formatCvarValue(def, value);
}

/** undefined: left empty; otherwise the parsed value or the error. */
function readField(
  field: Field
): ReturnType<typeof parseCvarValue> | undefined {
  if (field.input.value.trim() === '') return undefined;
  return parseCvarValue(field.def, field.input.value);
}

function renderHint({ def, input, hint, sent }: Field): void {
  const parsed = readField({ def, input, hint });
  const invalid = parsed !== undefined && !parsed.ok;
  input.setAttribute('aria-invalid', String(invalid));
  hint.classList.toggle('error', invalid);
  if (parsed && !parsed.ok) {
    hint.textContent = parsed.error;
    return;
  }
  const parts = [
    def.kind === 'number' ? describeRange(def) : '',
    APPLIES_TEXT[def.applies],
  ];
  if (sent !== undefined) parts.push(`Sent: ${valueText(def, sent)}`);
  hint.textContent = parts.filter(Boolean).join(' · ');
}

/** The filled-in fields, or the first error. */
function readFields():
  | { ok: true; values: Partial<Record<CvarName, number>> }
  | { ok: false; error: string; field: Field } {
  const values: Partial<Record<CvarName, number>> = {};
  for (const field of fields) {
    const parsed = readField(field);
    if (!parsed) continue;
    if (!parsed.ok) return { ok: false, error: parsed.error, field };
    values[field.def.name] = parsed.value;
  }
  return { ok: true, values };
}

function refresh(): void {
  const read = readFields();
  const filled = read.ok && Object.keys(read.values).length > 0;
  apply.disabled = isBusy() || !hasPassword() || !filled;
  restart.disabled = isBusy() || !hasPassword();
  for (const button of presetButtons) button.disabled = restart.disabled;
}

/** "Friendly fire off, Start money $16000, ...": shown as the tooltip. */
function presetSummary({ values }: Preset): string {
  return valuesSummary(values);
}

function valuesSummary(values: Preset['values']): string {
  return FIELDS.filter((name) => values[name] !== undefined)
    .map((name) => {
      const def = CVARS[name];
      const value = valueText(def, values[name]!);
      if (def.unit === '$') return `${def.label} $${value}`;
      return `${def.label} ${value}${def.unit ? ` ${def.unit}` : ''}`;
    })
    .join(', ');
}

function renderFunMapNote(): void {
  const prefixes = FUN_MAP_PREFIXES.join(', ').replace(/, ([^,]*)$/, ' and $1');
  let text =
    `${prefixes} maps set ${valuesSummary(FUN_MAP_VALUES)} when they load, ` +
    'over what is set here. The map after one goes back to ' +
    `${valuesSummary(AFTER_FUN_MAP_VALUES)}.`;
  const next = getNextMap();
  if (next !== undefined && isFunMap(next)) {
    text = `The next map, ${next}, has its own settings. ${text}`;
  }
  funMapNote.textContent = text;
}

function renderModeNote(): void {
  const name = gameMode === undefined ? '' : gameModeName(gameMode);
  modeNote.textContent = name
    ? `${name} is on. Knife only and pistols only don't work in it: ` +
      'pick Casual, Competitive or Warmup (or Game mode Classic) first.'
    : '';
  modeNote.hidden = name === '';
}

/** Reads the game mode from the lobby status (A2S_RULES). */
async function refreshGameMode(): Promise<void> {
  const asked = Date.now();
  const status = await fetchLobbyStatus();
  // Something sent since (or just before) the request wins.
  if (!status || asked - gameModeSentAt < GAME_MODE_SETTLE_MS) return;
  gameMode = status.gameMode;
  renderModeNote();
}

/**
 * Why `values` can't be sent: a weapon mode while a game mode is (or would
 * be) on. undefined if it can.
 */
function weaponModeBlocked(
  values: Partial<Record<CvarName, number>>
): string | undefined {
  const weapon = values.wc_weaponmode;
  const mode = values.wc_gamemode ?? gameMode;
  if (!weapon || !mode) return undefined;
  const name = gameModeName(mode) || 'a game mode';
  const weaponName = choiceName(CVARS.wc_weaponmode, weapon);
  return (
    `Not sent: ${weaponName.charAt(0).toUpperCase()}${weaponName.slice(1)} ` +
    `doesn't work during ${name}. Pick Casual, Competitive or Warmup (or ` +
    'Game mode Classic) first.'
  );
}

function renderPresetNote(): void {
  if (!lastPreset) {
    presetNote.textContent =
      'Each mode sends a group of settings, then restarts the round. Last applied: none.';
    return;
  }
  const { preset, restart, mapChanged } = lastPreset;
  let text = `Last applied: ${preset.label}`;
  if (restart === undefined) text += ' (restarting...)';
  else if (restart !== 'done') text += " (round restart wasn't confirmed)";
  // The weapon mode plugin puts its value back on every map change.
  const reset = FIELDS.filter((name) => {
    const { mapReset } = CVARS[name];
    const value = preset.values[name];
    return mapReset !== undefined && value !== undefined && value !== mapReset;
  });
  if (mapChanged && reset.length > 0) {
    const labels = reset.map((name) => CVARS[name].label).join(', ');
    text += `. The map changed since, so ${labels} went back to the map-start value`;
  }
  presetNote.textContent = `${text}.`;
}

/** Sends the preset's cvars, then restarts the round. */
async function applyPreset(preset: Preset): Promise<void> {
  // restartRound makes isBusy() true before it awaits, so a second click
  // (or a click on another preset) is ignored until the restart settles.
  if (isBusy()) return;
  if (!sendCvars(preset.values)) return;
  const entry: NonNullable<typeof lastPreset> = { preset, mapChanged: false };
  lastPreset = entry;
  renderPresetNote();
  const result = await restartRound(
    `Done. ${preset.label} applied and the round restarted.`
  );
  // A newer preset may have been sent while this one waited.
  if (lastPreset !== entry) return;
  entry.restart = result ?? 'timeout';
  renderPresetNote();
}

/**
 * Sends `<cvar> <value>` for each entry, after checking all of them, and
 * shows them as sent. Returns false, with the reason in the status line, if
 * a value is invalid or nothing could be sent.
 */
export function sendCvars(values: Partial<Record<CvarName, number>>): boolean {
  const blocked = weaponModeBlocked(values);
  if (blocked) {
    setStatus(blocked, true);
    return false;
  }
  const commands: [Field, number, string][] = [];
  for (const [name, value] of Object.entries(values)) {
    const field = fields.find(({ def }) => def.name === name);
    if (!field) throw new Error(`${name} isn't a field of the Match tab.`);
    if (value === undefined) continue;
    let command: string;
    try {
      command = cvarCommand(field.def, value);
    } catch (error) {
      setStatus((error as Error).message, true);
      return false;
    }
    commands.push([field, value, command]);
  }
  if (commands.length === 0) return false;
  for (const [field, value] of commands) {
    if (!sendAction({ action: 'cvar', name: field.def.name, value })) {
      return false;
    }
    field.sent = value;
    renderHint(field);
    if (field.def.name === 'wc_gamemode') {
      gameMode = value;
      gameModeSentAt = Date.now();
      renderModeNote();
    }
  }
  return true;
}

function applySettings(): void {
  if (isBusy()) return;
  const read = readFields();
  if (!read.ok) {
    setStatus(read.error, true);
    read.field.input.focus();
    return;
  }
  if (Object.keys(read.values).length === 0) return;
  if (!sendCvars(read.values)) return;
  for (const field of fields) {
    if (read.values[field.def.name] === undefined) continue;
    field.input.value = '';
    renderHint(field);
  }
  refresh();
  const later = fields.some(
    ({ def }) => read.values[def.name] !== undefined && def.applies !== 'now'
  );
  // Nothing on the HUD confirms a cvar, so this can't say "Done".
  setStatus(
    later ? 'Sent. Restart the round to apply everything now.' : 'Sent.'
  );
}

/**
 * Sends `sv_restart 1` and waits for the round clock to restart. Resolves
 * undefined if nothing was sent (busy, or no game/password).
 */
export async function restartRound(
  doneMessage = 'Done. The round restarted.'
): Promise<EffectResult | undefined> {
  if (isBusy()) return undefined;
  if (!sendAction({ action: 'restart' })) return undefined;
  setStatus('Restarting the round...');
  // The client resends the round clock (RoundTime) when a round starts.
  // While it runs, each timer event is one second less than the last, so
  // any other value, or the same value again, is a new round.
  let previous = lastTimer;
  let mapChanged = false;
  const result = await expectEffect((event) => {
    if (event.type === 'reset') mapChanged = true;
    if (event.type !== 'timer' || mapChanged) return false;
    const { seconds, bombPlanted } = event.payload;
    const jumped = previous === undefined || seconds !== previous - 1;
    previous = seconds;
    return jumped && !bombPlanted;
  }, RESTART_TIMEOUT_MS);
  if (result === 'done') {
    setStatus(doneMessage);
  } else if (result === 'timeout') {
    setStatus(
      "The round didn't restart. Check the password and try again.",
      true
    );
  }
  return result;
}

export const matchTab: AdminTab = {
  id: 'match',
  label: 'Match',
  panel,
  // The fun map note depends on the next map, read on the Map tab; the
  // weapon mode note on the game mode, read from the lobby status.
  show: () => {
    refreshNextMap();
    void refreshGameMode();
  },
  submit: applySettings,
  refresh,
  focusTarget: () => fields[0].input,
};
