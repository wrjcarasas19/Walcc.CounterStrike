import { onHudEvent, type HudEvent } from '../hud';
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
import { PRESETS, type Preset } from './presets';

// Match settings: game mode presets, one cvar per field, plus "Restart
// round". rcon has no reply and cvar changes have no HUD event, so settings
// only show "Sent". A restart (also the end of every preset) is confirmed by
// the round timer jumping.

const FIELDS: readonly CvarName[] = [
  'mp_friendlyfire',
  'mp_timelimit',
  'mp_roundtime',
  'mp_startmoney',
  'mp_freezetime',
  'mp_buytime',
  'mp_maxrounds',
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
presetLabel.textContent = 'Game mode';
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
presetGroup.append(presetLabel, presetRow, presetNote);

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

panel.append(presetGroup, grid, cfgNote, apply, restart);

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
renderPresetNote();
onHudEvent(trackEvent);

function trackEvent(event: HudEvent): void {
  if (event.type === 'timer') lastTimer = event.payload.seconds;
  else if (event.type === 'reset') {
    lastTimer = undefined;
    if (lastPreset) lastPreset.mapChanged = true;
    renderPresetNote();
    // The weapon mode plugin has just put its value back.
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
  return FIELDS.filter((name) => values[name] !== undefined)
    .map((name) => {
      const def = CVARS[name];
      const value = valueText(def, values[name]!);
      if (def.unit === '$') return `${def.label} $${value}`;
      return `${def.label} ${value}${def.unit ? ` ${def.unit}` : ''}`;
    })
    .join(', ');
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
  submit: applySettings,
  refresh,
  focusTarget: () => fields[0].input,
};
