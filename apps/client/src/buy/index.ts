import type { Xash3D } from 'xash3d-fwgs';
import { versionAtLeast } from '../gamemode';
import { onHudEvent } from '../hud';
import { createModal, type Modal } from '../modal';
import { getSettings, onSettingsChange } from '../settings/store';
import { itemIndexForKey } from '../wheel/items';
import {
  BUYMENU_EVENT_CLIENT_VERSION,
  allImages,
  canBuy,
  categoryForMenu,
  categoryItems,
  isAssassinationMap,
  mainEntries,
  type BuyItem,
  type BuyMenuEvent,
  type CategoryId,
  type Team,
} from './items';
import { decodeTga } from './tga';

// Buy menu with the game's weapon pictures, in place of the stock text menu.
// The server still opens and closes it: B runs `buy`, the server sends its
// text menu, and the game client (cs16-client 0.0.11+, web_bridge.h
// "buymenu") hides that menu and tells the page while the cvar
// hud_html_buymenu is 1 (set here from the `buyMenu` setting). Items are
// bought with the game's buy aliases (`ak47`), and closing the menu here runs
// `slot10`, which closes the client's hidden menu and the server's
// (`menuselect 10`). Number keys work as in the stock menus (B 4 2: AK-47).
// Open, close, Esc, keys and the pointer lock come from ../modal.ts.

// Where main.ts (loadGameFiles) unpacks the game files.
const PICTURE_DIR = '/rodir/cstrike/gfx/vgui';

const supported = versionAtLeast(
  __CS16_CLIENT_VERSION__,
  BUYMENU_EVENT_CLIENT_VERSION
);

const menu = document.getElementById('buy-menu')!;
const panel = document.getElementById('buy-panel')!;

let engine: Xash3D | undefined;
let touchControls = false;
let gameMenuOpen = false;
// The server has a buy menu open (between "buymenu" open and close).
let requested = false;
// Set while the client closed the menu, so closing it here sends nothing.
let closedByClient = false;
let team: Team = 'CT';
let assassination = false;
let money: number | undefined;
// 'main': number keys pick a category; 'category': they buy an item.
let level: 'main' | 'category' = 'main';
let shown: CategoryId = 'rifles';
// Picture data URLs by file name, read from the engine's files on first open.
const pictures = new Map<string, string>();
let picturesLoaded = false;

const header = document.createElement('header');
header.className = 'admin-header buy-header';
const title = document.createElement('span');
title.id = 'buy-title';
title.className = 'admin-title';
title.textContent = 'Buy';
const teamTag = document.createElement('span');
teamTag.className = 'buy-team';
const moneyText = document.createElement('span');
moneyText.className = 'buy-money';
const closeHint = document.createElement('span');
closeHint.className = 'admin-hint buy-close-hint';
closeHint.textContent = 'B / Esc to close';
header.append(title, teamTag, moneyText, closeHint);
const categoriesBox = document.createElement('nav');
categoriesBox.className = 'buy-categories';
categoriesBox.setAttribute('aria-label', 'Categories');
const itemsBox = document.createElement('div');
itemsBox.className = 'buy-items';
const body = document.createElement('div');
body.className = 'buy-body';
body.append(categoriesBox, itemsBox);
const keyHint = document.createElement('div');
keyHint.className = 'buy-key-hint';
panel.append(header, body, keyHint);

function relock(): boolean {
  return !touchControls;
}

function affordable(item: BuyItem): boolean {
  return money === undefined || item.price === undefined || item.price <= money;
}

function buyable(item: BuyItem): boolean {
  return canBuy(item, team, assassination) && affordable(item);
}

function keyBadge(key: number, shownNow: boolean): HTMLElement {
  const badge = document.createElement('span');
  badge.className = 'buy-key';
  badge.textContent = String(key);
  badge.hidden = !shownNow;
  return badge;
}

function render(): void {
  panel.dataset.team = team;
  teamTag.textContent = team === 'CT' ? 'Counter-Terrorists' : 'Terrorists';
  moneyText.textContent =
    money === undefined ? '' : `$${money.toLocaleString('en-US')}`;
  keyHint.textContent =
    level === 'main'
      ? '1-8: category · 0: close'
      : '1-9: buy · Backspace: categories · 0: close';

  categoriesBox.replaceChildren(
    ...mainEntries().map((entry, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'buy-category';
      const label = document.createElement('span');
      label.className = 'buy-category-label';
      button.append(keyBadge(index + 1, level === 'main'), label);
      if (entry.kind === 'category') {
        label.textContent = entry.label;
        button.setAttribute('aria-pressed', String(entry.id === shown));
        button.addEventListener('click', () => showCategory(entry.id));
      } else {
        label.textContent = entry.item.label;
        button.classList.add('buy-direct');
        button.disabled = !buyable(entry.item);
        button.addEventListener('click', () => buy(entry.item));
      }
      return button;
    })
  );

  itemsBox.replaceChildren(
    ...categoryItems(shown, team).map((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'buy-item';
      const allowed = canBuy(item, team, assassination);
      button.disabled = !allowed || !affordable(item);
      if (!allowed) button.title = 'Not sold on this map';
      else if (!affordable(item)) button.title = 'Not enough money';
      const picture = document.createElement('span');
      picture.className = 'buy-picture';
      const url = item.image && pictures.get(item.image);
      if (url) {
        const img = document.createElement('img');
        img.alt = '';
        img.src = url;
        picture.append(img);
      }
      const name = document.createElement('span');
      name.className = 'buy-name';
      name.textContent = item.label;
      const price = document.createElement('span');
      price.className = 'buy-price';
      price.textContent =
        item.price === undefined
          ? ''
          : `$${item.price.toLocaleString('en-US')}`;
      button.append(
        keyBadge(index + 1, level === 'category'),
        picture,
        name,
        price
      );
      button.addEventListener('click', () => buy(item));
      return button;
    })
  );
}

function showCategory(id: CategoryId): void {
  shown = id;
  level = 'category';
  render();
}

function buy(item: BuyItem): void {
  if (!engine || !modal.isOpen() || !buyable(item)) return;
  engine.Cmd_ExecuteString(item.command);
  // Like the stock menu, one purchase per opening.
  modal.close(relock());
}

// Reads the pictures once per engine; a missing or broken file leaves its
// item without one.
function loadPictures(): void {
  if (picturesLoaded || !engine) return;
  picturesLoaded = true;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return;
  const failed: string[] = [];
  for (const name of allImages()) {
    try {
      const image = decodeTga(
        engine.em.FS.readFile(`${PICTURE_DIR}/${name}.tga`)
      );
      canvas.width = image.width;
      canvas.height = image.height;
      context.putImageData(
        new ImageData(image.data, image.width, image.height),
        0,
        0
      );
      pictures.set(name, canvas.toDataURL('image/png'));
    } catch {
      failed.push(name);
    }
  }
  if (failed.length > 0) {
    console.warn(`Buy menu pictures not loaded: ${failed.join(', ')}`);
  }
}

const modal: Modal = createModal({
  backdrop: menu,
  panel,
  // Matched by the character, like the engine's binds (b is `buy`). Only
  // closes: canOpen is false until the server opened its menu.
  toggleKey: (event) =>
    event.key.toLowerCase() === 'b' &&
    !event.altKey &&
    !event.metaKey &&
    !event.ctrlKey,
  canOpen: () => !!engine && requested && !gameMenuOpen,
  onOpen() {
    loadPictures();
    render();
  },
  onClose() {
    requested = false;
    if (!closedByClient) engine?.Cmd_ExecuteString('slot10');
  },
  onKeyDown(event) {
    if (event.code === 'Digit0' || event.code === 'Numpad0') {
      modal.close(relock());
      return true;
    }
    if (event.code === 'Backspace') {
      if (level === 'category') {
        level = 'main';
        render();
      }
      return true;
    }
    const index = itemIndexForKey(event.code);
    if (index < 0) return false;
    if (level === 'main') {
      const entry = mainEntries()[index];
      if (entry?.kind === 'category') showCategory(entry.id);
      else if (entry) buy(entry.item);
    } else {
      const item = categoryItems(shown, team)[index];
      if (item) buy(item);
    }
    return true;
  },
});

/** The client closed its menu (or dropped it): close without telling it. */
function closeFromClient(): void {
  requested = false;
  closedByClient = true;
  modal.close(false);
  closedByClient = false;
}

function onBuyMenu(event: BuyMenuEvent): void {
  if (!event.open) {
    closeFromClient();
    return;
  }
  if (!engine) return;
  team = event.team || 'CT';
  assassination = isAssassinationMap(event.map);
  const category = categoryForMenu(event.menu);
  if (category) {
    shown = category;
    level = 'category';
  } else if (!modal.isOpen()) {
    level = 'main';
  }
  requested = true;
  if (modal.isOpen()) {
    render();
    return;
  }
  modal.open();
  // Can't show it now (main menu open): the client hides its own, so close
  // it rather than leave an invisible menu taking the number keys.
  if (!modal.isOpen()) {
    requested = false;
    engine.Cmd_ExecuteString('slot10');
  }
}

onHudEvent((event) => {
  switch (event.type) {
    case 'buymenu':
      onBuyMenu(event.payload);
      break;
    case 'money':
      money = event.payload.amount;
      if (modal.isOpen()) render();
      break;
    case 'reset':
      money = undefined;
      closeFromClient();
      break;
    case 'alive':
      if (!event.payload.alive) modal.close(false);
      break;
    case 'menu':
      gameMenuOpen = event.payload.visible;
      if (gameMenuOpen) modal.close(false);
      break;
  }
});

function applySetting(): void {
  if (!engine || !supported) return;
  engine.Cmd_ExecuteString(`hud_html_buymenu ${getSettings().buyMenu ? 1 : 0}`);
}

onSettingsChange((_settings, changed) => {
  if (changed.includes('buyMenu')) applySetting();
});

/**
 * Turns the buy menu on for a running engine (call after engine.main(),
 * before connecting). touch: touch controls are on.
 */
export function attachBuyMenu(target: Xash3D, touch: boolean): void {
  engine = target;
  touchControls = touch;
  gameMenuOpen = false;
  requested = false;
  money = undefined;
  pictures.clear();
  picturesLoaded = false;
  applySetting();
}

/** Closes the menu and stops sending commands (connection lost). */
export function detachBuyMenu(): void {
  closeFromClient();
  engine = undefined;
}
