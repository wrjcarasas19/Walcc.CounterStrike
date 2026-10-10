import type { Xash3D } from 'xash3d-fwgs';
import { onHudEvent } from '../hud';
import { createInviteSection } from '../invite';
import { createModal, type Modal } from '../modal';
import { createNameSection, refreshNameSection } from '../names';
import {
  cvarCommands,
  formatNumber,
  hudStyle,
  SETTING_KEYS,
  SETTINGS,
  type SettingDef,
  type SettingGroup,
  type SettingKey,
  type Settings,
} from './schema';
import {
  getSettings,
  onSettingsChange,
  resetSettings,
  setSetting,
} from './store';

// Settings panel (F3, the Settings button on the login page, or the gear
// button in game with touch controls). Controls are built from SETTINGS;
// every change is saved and applied at once: cvars through the engine's
// console, HUD size and opacity as CSS variables on #hud.

const menu = document.getElementById('settings-menu')!;
const panel = document.getElementById('settings-panel')!;
const body = document.getElementById('settings-body')!;
const resetButton = document.getElementById(
  'settings-reset'
) as HTMLButtonElement;
const closeButton = document.getElementById(
  'settings-close'
) as HTMLButtonElement;
const launcherButton = document.getElementById(
  'settings-launcher-button'
) as HTMLButtonElement | null;
const touchButton = document.getElementById(
  'settings-button'
) as HTMLButtonElement;
const hud = document.getElementById('hud')!;

let engine: Xash3D | undefined;
let touchControls = false;
let gameMenuOpen = false;
let opener: HTMLElement | null = null;

type Control = { focus: HTMLElement; render(settings: Settings): void };

const controls = new Map<SettingKey, Control>();

function controlId(key: SettingKey): string {
  return `setting-${key}`;
}

function numberControl(
  key: SettingKey,
  def: Extract<SettingDef, { kind: 'number' }>
): { element: HTMLElement; control: Control } {
  const field = document.createElement('div');
  field.className = 'field settings-field';
  const head = document.createElement('div');
  head.className = 'settings-field-head';
  const label = document.createElement('label');
  label.className = 'field-label';
  label.htmlFor = controlId(key);
  label.textContent = def.label;
  const output = document.createElement('output');
  output.className = 'settings-value';
  output.htmlFor.add(controlId(key));
  head.append(label, output);

  const input = document.createElement('input');
  input.type = 'range';
  input.id = controlId(key);
  input.className = 'settings-range';
  input.min = String(def.min);
  input.max = String(def.max);
  input.step = String(def.step);
  input.addEventListener('input', () => {
    setSetting(key, Number(input.value));
  });
  field.append(head, input);

  return {
    element: field,
    control: {
      focus: input,
      render(settings) {
        const value = settings[key] as number;
        input.value = String(value);
        const text = formatNumber(def, value);
        output.textContent = text;
        input.setAttribute('aria-valuetext', text);
      },
    },
  };
}

function choiceControl(
  key: SettingKey,
  def: Extract<SettingDef, { kind: 'choice' }>
): { element: HTMLElement; control: Control } {
  const field = document.createElement('div');
  field.className = 'field settings-field';
  const label = document.createElement('label');
  label.className = 'field-label';
  label.htmlFor = controlId(key);
  label.textContent = def.label;
  const select = document.createElement('select');
  select.id = controlId(key);
  select.className = 'field-input';
  for (const option of def.options) {
    select.add(new Option(option.label, option.value));
  }
  select.addEventListener('change', () => {
    setSetting(key, select.value as Settings[SettingKey]);
  });
  field.append(label, select);

  return {
    element: field,
    control: {
      focus: select,
      render(settings) {
        select.value = settings[key] as string;
      },
    },
  };
}

function toggleControl(
  key: SettingKey,
  def: Extract<SettingDef, { kind: 'toggle' }>
): { element: HTMLElement; control: Control } {
  const label = document.createElement('label');
  label.className = 'settings-toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = controlId(key);
  input.addEventListener('change', () => {
    setSetting(key, input.checked);
  });
  const text = document.createElement('span');
  text.className = 'settings-toggle-label';
  text.textContent = def.label;
  label.append(input, text);
  if (def.hint) {
    const hint = document.createElement('span');
    hint.className = 'settings-toggle-hint';
    hint.textContent = def.hint;
    label.append(hint);
  }

  return {
    element: label,
    control: {
      focus: input,
      render(settings) {
        input.checked = settings[key] as boolean;
      },
    },
  };
}

function buildPanel(): void {
  const groups = new Map<SettingGroup, HTMLElement>();
  for (const key of SETTING_KEYS) {
    const def: SettingDef = SETTINGS[key];
    let group = groups.get(def.group);
    if (!group) {
      const section = document.createElement('section');
      section.className = 'settings-group';
      section.setAttribute('aria-label', def.group);
      const title = document.createElement('h2');
      title.className = 'settings-group-title';
      title.textContent = def.group;
      const fields = document.createElement('div');
      fields.className = 'settings-fields';
      section.append(title, fields);
      body.append(section);
      group = fields;
      groups.set(def.group, group);
    }
    const { element, control } =
      def.kind === 'number'
        ? numberControl(key, def)
        : def.kind === 'choice'
          ? choiceControl(key, def)
          : toggleControl(key, def);
    group.append(element);
    controls.set(key, control);
  }
}

function render(settings: Settings): void {
  for (const control of controls.values()) control.render(settings);
}

function applyHud(settings: Settings): void {
  for (const [name, value] of Object.entries(hudStyle(settings))) {
    hud.style.setProperty(name, value);
  }
}

function runCommands(commands: string[]): void {
  if (!engine) return;
  for (const command of commands) engine.Cmd_ExecuteString(command);
}

function refreshTouchButton(): void {
  touchButton.hidden = !engine || !touchControls || gameMenuOpen;
}

const modal: Modal = createModal({
  backdrop: menu,
  panel,
  toggleKey: 'F3',
  canOpen: () => true,
  onOpen() {
    opener = document.activeElement as HTMLElement | null;
    render(getSettings());
    refreshNameSection();
    controls.get(SETTING_KEYS[0])?.focus.focus();
  },
  onClose() {
    // On the login page focus goes back to where it was; in game it stays
    // off the page so keys reach the engine.
    if (!engine && opener?.isConnected) opener.focus();
    opener = null;
  },
});

buildPanel();
// The invite link sits here because this panel is the one every player can
// open, both in game and on the login page.
// "Your name" (claimed names) goes right under it, for the same reason.
const inviteSection = createInviteSection();
body.prepend(inviteSection);
inviteSection.after(createNameSection());
render(getSettings());
applyHud(getSettings());

onSettingsChange((settings, changed) => {
  render(settings);
  applyHud(settings);
  runCommands(cvarCommands(settings, changed));
});

onHudEvent((event) => {
  if (event.type !== 'menu') return;
  gameMenuOpen = event.payload.visible;
  refreshTouchButton();
});

resetButton.addEventListener('click', () => {
  resetSettings();
});
// A click is a user gesture, so the pointer lock can be taken back (not
// used with touch controls).
closeButton.addEventListener('click', () => modal.close(!touchControls));
launcherButton?.addEventListener('click', () => modal.open());
touchButton.addEventListener('click', () => modal.open());

/**
 * Applies the saved settings to a running engine (call after engine.main()
 * and before connecting), and from then on applies every change at once.
 * touch: touch controls are on, so the in-game settings button is shown.
 */
export function attachSettings(target: Xash3D, touch: boolean): void {
  engine = target;
  touchControls = touch;
  gameMenuOpen = false;
  runCommands(cvarCommands(getSettings()));
  refreshTouchButton();
}

/** Stops applying changes to the engine (connection lost). */
export function detachSettings(): void {
  modal.close(false);
  engine = undefined;
  refreshTouchButton();
}
