import type { Xash3D } from 'xash3d-fwgs';
import { versionAtLeast } from '../gamemode';
import { onHudEvent } from '../hud';
import { createModal, type Modal } from '../modal';
import { getSettings, onSettingsChange } from '../settings/store';
import { readVguiPictures } from '../vgui-pictures';
import { itemIndexForKey } from '../wheel/items';
import {
  TEAMMENU_EVENT_CLIENT_VERSION,
  allImages,
  canCancel,
  classSide,
  menuKind,
  menuOptions,
  type Team,
  type TeamMenuEvent,
  type TeamOption,
} from './items';

// Team and character menus with the game's pictures, in place of the stock
// text menus. The server still opens and closes them: it sends its team menu
// on joining and on M (`chooseteam`), and its character menu after a team
// pick; the game client (cs16-client 0.0.12+, web_bridge.h "teammenu") hides
// them and tells the page while the cvar hud_html_teammenu is 1 (set here
// from the `teamMenu` setting). A pick runs `slotN`, which the client's
// hidden menu sends on as `menuselect N`; closing runs `slot10`. The menu on
// joining has no key 0, so Esc and M leave it open; when another menu (F3,
// F4, the main menu) hides it, M or the main menu closing brings it back.
// Open, close, keys and the pointer lock come from ../modal.ts.

const supported = versionAtLeast(
  __CS16_CLIENT_VERSION__,
  TEAMMENU_EVENT_CLIENT_VERSION
);

const menu = document.getElementById('team-menu')!;
const panel = document.getElementById('team-panel')!;

let engine: Xash3D | undefined;
let touchControls = false;
let gameMenuOpen = false;
// The server has a team or character menu open (between "teammenu" open and
// close), shown or not.
let requested = false;
// Set while the page closes its menu without sending slot10: the client
// closed its own, or a pick is about to.
let silentClose = false;
let menuName = '';
let keys = 0;
let team: Team | '' = '';
// Picture data URLs by file name, read from the engine's files on first open.
let pictures = new Map<string, string>();
let picturesLoaded = false;

const header = document.createElement('header');
header.className = 'admin-header buy-header';
const title = document.createElement('span');
title.id = 'team-title';
title.className = 'admin-title';
const teamTag = document.createElement('span');
teamTag.className = 'buy-team';
const closeHint = document.createElement('span');
closeHint.className = 'admin-hint buy-close-hint team-close-hint';
header.append(title, teamTag, closeHint);
const optionsBox = document.createElement('div');
optionsBox.className = 'team-options';
const keyHint = document.createElement('div');
keyHint.className = 'buy-key-hint';
panel.append(header, optionsBox, keyHint);

function relock(): boolean {
  return !touchControls;
}

function teamName(side: Team): string {
  return side === 'CT' ? 'Counter-Terrorists' : 'Terrorists';
}

// "1-5" for keys in a row, else "1, 2, 5" (the in-game team menu).
function keyList(keys: number[]): string {
  const inRow = keys.every((key, i) => i === 0 || key === keys[i - 1] + 1);
  return inRow && keys.length > 2
    ? `${keys[0]}-${keys[keys.length - 1]}`
    : keys.join(', ');
}

function render(): void {
  const kind = menuKind(menuName);
  const side = classSide(menuName);
  const cancel = canCancel(keys);
  panel.dataset.team = side ?? '';
  title.textContent = kind === 'class' ? 'Choose a character' : 'Choose a team';
  teamTag.textContent = side ? teamName(side) : '';
  closeHint.textContent = cancel ? 'M / Esc to close' : '';
  const options = menuOptions(menuName, keys);
  keyHint.textContent =
    `${keyList(options.map((option) => option.key))}: choose` +
    (cancel ? ' · 0: close' : '');

  optionsBox.replaceChildren(
    ...options.map((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'team-option';
      button.dataset.side = option.side ?? '';
      // The in-game team menu: the team the player is on now.
      const current =
        kind === 'team' &&
        team !== '' &&
        option.side === team &&
        option.thenClass === true;
      const badge = document.createElement('span');
      badge.className = 'buy-key';
      badge.textContent = String(option.key);
      const picture = document.createElement('span');
      picture.className = 'team-picture';
      const url = option.image && pictures.get(option.image);
      if (url) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = url;
        picture.append(img);
      }
      const name = document.createElement('span');
      name.className = 'team-name';
      name.textContent = option.label;
      const detail = document.createElement('span');
      detail.className = 'team-detail';
      detail.textContent = current ? 'Your team' : (option.detail ?? '');
      if (current) button.classList.add('team-current');
      button.append(badge, picture, name, detail);
      button.addEventListener('click', () => choose(option));
      return button;
    })
  );
}

function choose(option: TeamOption): void {
  if (!engine || !modal.isOpen()) return;
  // The slot key closes the client's menu (and its "teammenu" close finds
  // this one closed). Keep the pointer free when the character menu follows.
  silentClose = true;
  modal.close(!option.thenClass && relock());
  silentClose = false;
  requested = false;
  engine.Cmd_ExecuteString(`slot${option.key}`);
}

function loadPictures(): void {
  if (picturesLoaded || !engine) return;
  picturesLoaded = true;
  pictures = readVguiPictures(engine, allImages(), 'Team menu');
}

const modal: Modal = createModal({
  backdrop: menu,
  panel,
  // Matched by the character, like the engine's binds (m is `chooseteam`).
  // Only closes or brings back a hidden menu: canOpen is false until the
  // server opened its menu, so otherwise M reaches the game.
  toggleKey: (event) =>
    event.key.toLowerCase() === 'm' &&
    !event.altKey &&
    !event.metaKey &&
    !event.ctrlKey,
  canOpen: () => !!engine && requested && !gameMenuOpen,
  canClose: () => canCancel(keys),
  onOpen() {
    loadPictures();
    render();
  },
  onClose() {
    // A menu the player must answer stays open in the client, only hidden.
    if (silentClose || !canCancel(keys)) return;
    requested = false;
    engine?.Cmd_ExecuteString('slot10');
  },
  onKeyDown(event) {
    if (event.code === 'Digit0' || event.code === 'Numpad0') {
      if (canCancel(keys)) modal.close(relock());
      return true;
    }
    const index = itemIndexForKey(event.code);
    if (index < 0) return false;
    const option = menuOptions(menuName, keys).find(
      (candidate) => candidate.key === index + 1
    );
    if (option) choose(option);
    return true;
  },
});

/** The client closed its menu (or dropped it): close without telling it. */
function closeFromClient(): void {
  requested = false;
  silentClose = true;
  modal.close(false);
  silentClose = false;
}

function onTeamMenu(event: TeamMenuEvent): void {
  if (!event.open) {
    closeFromClient();
    return;
  }
  if (!engine) return;
  menuName = event.menu;
  keys = event.keys;
  team = event.team;
  requested = true;
  if (modal.isOpen()) {
    render();
    return;
  }
  modal.open();
  // Can't show it now (main menu open). Like the buy menu, close one the
  // player may close rather than leave an invisible menu taking the number
  // keys; one they must answer opens when the main menu closes.
  if (!modal.isOpen() && canCancel(keys)) {
    requested = false;
    engine.Cmd_ExecuteString('slot10');
  }
}

onHudEvent((event) => {
  switch (event.type) {
    case 'teammenu':
      onTeamMenu(event.payload);
      break;
    case 'reset':
      closeFromClient();
      break;
    case 'menu':
      gameMenuOpen = event.payload.visible;
      if (gameMenuOpen) modal.close(false);
      else if (requested) modal.open();
      break;
  }
});

function applySetting(): void {
  if (!engine || !supported) return;
  engine.Cmd_ExecuteString(
    `hud_html_teammenu ${getSettings().teamMenu ? 1 : 0}`
  );
}

onSettingsChange((_settings, changed) => {
  if (changed.includes('teamMenu')) applySetting();
});

/**
 * Turns the team and character menus on for a running engine (call after
 * engine.main(), before connecting). touch: touch controls are on.
 */
export function attachTeamMenu(target: Xash3D, touch: boolean): void {
  engine = target;
  touchControls = touch;
  gameMenuOpen = false;
  requested = false;
  pictures = new Map();
  picturesLoaded = false;
  applySetting();
}

/** Closes the menu and stops sending commands (connection lost). */
export function detachTeamMenu(): void {
  closeFromClient();
  engine = undefined;
}
