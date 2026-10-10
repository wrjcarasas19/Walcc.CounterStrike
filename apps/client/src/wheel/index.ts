import type { Xash3D } from 'xash3d-fwgs';
import { onHudEvent } from '../hud';
import { anyModalOpen, createModal, type Modal } from '../modal';
import { getSettings } from '../settings/store';
import {
  clampVector,
  itemCommand,
  itemIndexForKey,
  PAGES,
  sectorAngle,
  sectorAt,
  stepPage,
  wheelKeyMatches,
  type WheelItem,
} from './items';

// Radio and quick chat wheel. Hold the key from the settings (Z by default)
// and move the mouse towards an item, or press its number; releasing the key
// sends the highlighted item, or nothing. A quick tap of the key (or of the
// touch button) leaves the wheel open to click or tap an item. With touch
// controls a button opens it: slide from the button towards an item and let
// go, or tap the button and then tap an item. Q / E, the arrow keys, the
// mouse wheel or the page buttons switch between pages. Open, close, Esc,
// keys and the pointer lock come from ../modal.ts.

type Mode = 'hold-key' | 'hold-touch' | 'sticky';

// A release this soon after opening, with nothing chosen, keeps the wheel
// open instead of closing it.
const STICKY_MS = 300;
// Movement (px) before a direction picks an item while holding.
const HOLD_DEAD_ZONE = 24;
// Clicks and taps in sticky mode: the centre (fraction of the wheel size)
// does nothing, outside the wheel closes it.
const INNER_RADIUS = 0.2;
const OUTER_RADIUS = 0.5;
const PAGE_SWITCH_MS = 150;

const menu = document.getElementById('wheel-menu')!;
const panel = document.getElementById('wheel-panel')!;
const touchButton = document.getElementById(
  'wheel-button'
) as HTMLButtonElement;

let engine: Xash3D | undefined;
let touchControls = false;
let gameMenuOpen = false;
// The engine's own chat line (messagemode, Y / U in stock CS 1.6) gives the
// page no event; while it is probably open, the wheel key types its letter
// there instead of opening the wheel.
let typingInChat = false;

let mode: Mode = 'hold-key';
let nextMode: Mode | undefined;
let pageIndex = 0;
let highlight = -1;
let openedAt = 0;
// Hold modes: mouse movement since opening, or the finger's offset from
// where it touched the button.
let vector = { x: 0, y: 0 };
let drag: { pointerId: number; x: number; y: number } | undefined;
let lastPageSwitch = 0;

// The wheel: page buttons above a ring of item buttons around a centre with
// the page name and a hint.
const tabs = document.createElement('div');
tabs.className = 'wheel-tabs';
const wheel = document.createElement('div');
wheel.className = 'wheel';
const ring = document.createElement('div');
ring.className = 'wheel-ring';
const highlightRing = document.createElement('div');
highlightRing.className = 'wheel-highlight';
const itemsBox = document.createElement('div');
itemsBox.className = 'wheel-items';
const centre = document.createElement('div');
centre.className = 'wheel-centre';
const pageTitle = document.createElement('span');
pageTitle.className = 'wheel-page';
const hint = document.createElement('span');
hint.className = 'wheel-hint';
centre.append(pageTitle, hint);
const pointer = document.createElement('div');
pointer.className = 'wheel-pointer';
wheel.append(ring, highlightRing, itemsBox, centre, pointer);
panel.append(tabs, wheel);

const tabButtons = PAGES.map((page, index) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wheel-tab';
  button.textContent = page.label;
  button.addEventListener('click', () => setPage(index));
  return button;
});
tabs.append(...tabButtons);

let itemButtons: HTMLButtonElement[] = [];

function items(): readonly WheelItem[] {
  return PAGES[pageIndex].items;
}

function renderPage(): void {
  const list = items();
  pageTitle.textContent = PAGES[pageIndex].label;
  tabButtons.forEach((button, index) => {
    button.setAttribute('aria-pressed', String(index === pageIndex));
  });
  itemButtons = list.map((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wheel-item';
    const angle = (sectorAngle(index, list.length) * Math.PI) / 180;
    button.style.left = `${50 + 36 * Math.sin(angle)}%`;
    button.style.top = `${50 - 36 * Math.cos(angle)}%`;
    const key = document.createElement('span');
    key.className = 'wheel-item-key';
    key.textContent = String(index + 1);
    const label = document.createElement('span');
    label.textContent = item.label;
    button.append(key, label);
    // Keyboard activation only (detail 0); pointers are handled on the
    // panel so a press-and-slide works the same as a click.
    button.addEventListener('click', (event) => {
      if (event.detail === 0) choose(index);
    });
    return button;
  });
  itemsBox.replaceChildren(...itemButtons);
  setHighlight(-1);
}

function renderMode(): void {
  menu.dataset.mode = mode;
  hint.textContent =
    mode === 'hold-key'
      ? 'Q / E: page · let go to cancel'
      : mode === 'hold-touch'
        ? 'Slide to an item and let go'
        : touchControls
          ? 'Tap an item · tap outside to close'
          : 'Click an item or press 1-9 · Esc to close';
  renderPointer();
}

function setHighlight(index: number): void {
  if (index === highlight) return;
  highlight = index;
  const count = items().length;
  itemButtons.forEach((button, i) => {
    button.classList.toggle('selected', i === index);
  });
  wheel.classList.toggle('has-selection', index >= 0);
  if (index >= 0) {
    const size = 360 / count;
    highlightRing.style.setProperty(
      '--from',
      `${sectorAngle(index, count) - size / 2}deg`
    );
    highlightRing.style.setProperty('--size', `${size}deg`);
  }
}

function renderPointer(): void {
  const radius = wheel.getBoundingClientRect().width * 0.42;
  const { x, y } = clampVector(vector.x, vector.y, radius);
  pointer.style.transform = `translate(${x}px, ${y}px)`;
}

function setPage(index: number): void {
  if (index === pageIndex) return;
  pageIndex = index;
  renderPage();
  // A held direction picks on the new page too.
  if (mode !== 'sticky') pickFromVector();
}

function pickFromVector(): void {
  setHighlight(sectorAt(vector.x, vector.y, items().length, HOLD_DEAD_ZONE));
  renderPointer();
}

// Sticky mode: the item under the pointer, -1 in the centre, undefined
// outside the wheel.
function itemAt(clientX: number, clientY: number): number | undefined {
  const rect = wheel.getBoundingClientRect();
  const dx = clientX - (rect.left + rect.width / 2);
  const dy = clientY - (rect.top + rect.height / 2);
  if (Math.hypot(dx, dy) > rect.width * OUTER_RADIUS) return undefined;
  return sectorAt(dx, dy, items().length, rect.width * INNER_RADIUS);
}

function relock(): boolean {
  return !touchControls && mode !== 'hold-touch';
}

function choose(index: number): void {
  const item = items()[index];
  if (!item || !modal.isOpen()) return;
  const command = itemCommand(item);
  const relocking = relock();
  modal.close(relocking);
  engine?.Cmd_ExecuteString(command);
}

// The key or finger was let go while holding.
function release(): void {
  if (highlight >= 0) {
    choose(highlight);
  } else if (performance.now() - openedAt < STICKY_MS) {
    mode = 'sticky';
    vector = { x: 0, y: 0 };
    renderMode();
  } else {
    modal.close(relock());
  }
}

const modal: Modal = createModal({
  backdrop: menu,
  panel,
  toggleKey: (event) => wheelKeyMatches(getSettings().radioWheelKey, event),
  canOpen: () =>
    !!engine &&
    !gameMenuOpen &&
    !anyModalOpen() &&
    (nextMode === 'hold-touch' || !typingInChat),
  onOpen() {
    mode = nextMode ?? 'hold-key';
    nextMode = undefined;
    openedAt = performance.now();
    vector = { x: 0, y: 0 };
    renderPage();
    renderMode();
  },
  onClose() {
    if (drag && touchButton.hasPointerCapture(drag.pointerId)) {
      touchButton.releasePointerCapture(drag.pointerId);
    }
    drag = undefined;
    nextMode = undefined;
  },
  onKeyDown(event) {
    const index = itemIndexForKey(event.code);
    if (index >= 0) {
      choose(index);
      return true;
    }
    if (event.code === 'KeyQ' || event.code === 'ArrowLeft') {
      setPage(stepPage(pageIndex, -1, PAGES.length));
      return true;
    }
    if (event.code === 'KeyE' || event.code === 'ArrowRight') {
      setPage(stepPage(pageIndex, 1, PAGES.length));
      return true;
    }
    return false;
  },
  onToggleKeyUp() {
    if (mode === 'hold-key') release();
  },
});

// Mouse and pen on the wheel (touch while holding goes to the touch button,
// which captured the pointer).
panel.addEventListener('pointermove', (event) => {
  if (mode === 'hold-key' && event.pointerType === 'mouse') {
    // The pointer lock is off while the wheel is open; movement still adds
    // up like turning would, so the cursor's position doesn't matter.
    vector = clampVector(
      vector.x + event.movementX,
      vector.y + event.movementY,
      wheel.getBoundingClientRect().width * 0.5
    );
    pickFromVector();
  } else if (mode === 'sticky') {
    setHighlight(itemAt(event.clientX, event.clientY) ?? -1);
  }
});

panel.addEventListener('pointerdown', (event) => {
  if (mode === 'hold-key') {
    // A click while holding the key sends the highlighted item.
    event.preventDefault();
    if (highlight >= 0) choose(highlight);
    else modal.close(relock());
    return;
  }
  if (mode === 'sticky' && !isOnTab(event)) {
    setHighlight(itemAt(event.clientX, event.clientY) ?? -1);
  }
});

panel.addEventListener('pointerup', (event) => {
  if (mode !== 'sticky' || isOnTab(event)) return;
  const index = itemAt(event.clientX, event.clientY);
  if (index === undefined) modal.close(relock());
  else if (index >= 0) choose(index);
});

panel.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const now = performance.now();
    if (event.deltaY === 0 || now - lastPageSwitch < PAGE_SWITCH_MS) return;
    lastPageSwitch = now;
    setPage(stepPage(pageIndex, Math.sign(event.deltaY), PAGES.length));
  },
  { passive: false }
);

function isOnTab(event: Event): boolean {
  return event.target instanceof Element && tabs.contains(event.target);
}

// Touch button: press opens the wheel; slide and let go, or tap.
touchButton.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  if (modal.isOpen()) return;
  nextMode = 'hold-touch';
  modal.open();
  if (!modal.isOpen()) {
    nextMode = undefined;
    return;
  }
  drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  touchButton.setPointerCapture(event.pointerId);
});

touchButton.addEventListener('pointermove', (event) => {
  if (mode !== 'hold-touch' || event.pointerId !== drag?.pointerId) return;
  vector = { x: event.clientX - drag.x, y: event.clientY - drag.y };
  pickFromVector();
});

touchButton.addEventListener('pointerup', (event) => {
  if (mode !== 'hold-touch' || event.pointerId !== drag?.pointerId) return;
  drag = undefined;
  release();
});

touchButton.addEventListener('pointercancel', (event) => {
  if (event.pointerId === drag?.pointerId) modal.close(false);
});

// Keyboard activation of the touch button: open to pick an item.
touchButton.addEventListener('click', (event) => {
  if (event.detail !== 0 || modal.isOpen()) return;
  nextMode = 'sticky';
  modal.open();
});

// Watches keys on their way to the engine. Registered after modal.ts's
// listener, so keys taken by an open menu never get here.
window.addEventListener(
  'keydown',
  (event) => {
    if (!engine || gameMenuOpen) return;
    if (event.code === 'KeyY' || event.code === 'KeyU') typingInChat = true;
    else if (event.code === 'Enter' || event.code === 'NumpadEnter') {
      typingInChat = false;
    }
  },
  { capture: true }
);

// A key held while the page loses focus never sends its keyup.
window.addEventListener('blur', () => modal.close(false));

onHudEvent((event) => {
  if (event.type !== 'menu') return;
  gameMenuOpen = event.payload.visible;
  if (gameMenuOpen) modal.close(false);
  refreshTouchButton();
});

function refreshTouchButton(): void {
  touchButton.hidden = !engine || !touchControls || gameMenuOpen;
}

renderPage();

/**
 * Lets the wheel send commands to a running engine (call after
 * engine.main()). touch: touch controls are on, so the wheel button is shown.
 */
export function attachWheel(target: Xash3D, touch: boolean): void {
  engine = target;
  touchControls = touch;
  gameMenuOpen = false;
  typingInChat = false;
  refreshTouchButton();
}

/** Stops sending commands (connection lost). */
export function detachWheel(): void {
  modal.close(false);
  engine = undefined;
  refreshTouchButton();
}
