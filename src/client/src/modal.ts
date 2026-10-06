// Shared behaviour for the HTML menus drawn over the game (admin F4,
// settings F3, the radio wheel held on Z): one opens at a time, a toggle key
// opens and closes it, Esc and backdrop clicks close it, focus is trapped
// inside, keys don't reach the game while it's open, and the pointer lock is
// released and taken back.

export type ModalOptions = {
  /** Full-screen element shown and hidden with the `hidden` attribute. */
  backdrop: HTMLElement;
  /** The menu itself: focus is kept inside it, clicks on it don't close. */
  panel: HTMLElement;
  /**
   * KeyboardEvent.code that opens and closes the menu, or a function telling
   * whether a keydown is the menu's key (e.g. a key picked in the settings).
   */
  toggleKey: string | ((event: KeyboardEvent) => boolean);
  /** False while the menu can't be used (e.g. the admin menu before a game). */
  canOpen(): boolean;
  /** Called after the menu became visible: fill it in and move focus. */
  onOpen(): void;
  /** Called after the menu was hidden. */
  onClose?(): void;
  /**
   * A keydown inside the open menu that isn't Esc, Tab or a toggle key.
   * Listeners inside the menu never see keys (see onKey), so menus handle
   * their own keys here. Return true to cancel the key's default action.
   */
  onKeyDown?(event: KeyboardEvent): boolean;
  /**
   * Hold-to-open menus: the toggle key was released while the menu is open.
   * With this set, the toggle key's keyup is kept from the game too (the game
   * never saw its keydown).
   */
  onToggleKeyUp?(): void;
};

export type Modal = {
  isOpen(): boolean;
  open(): void;
  /**
   * relock takes the pointer lock back for the game. Browsers only allow
   * that during a user gesture (a key or click), so pass true only then.
   */
  close(relock: boolean): void;
};

// The engine hardcodes these (Escape: main menu, `/~: console), so unbind
// can't remove them; they never reach it while a game is running.
const ENGINE_BLOCKED_KEYS = new Set(['Escape', 'Backquote']);
const FOCUSABLE = 'button, input, select, textarea, [tabindex]';

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const modals: ModalImpl[] = [];
// Toggle keys of hold-to-open menus that are down: KeyboardEvent.code -> menu.
const heldToggleKeys = new Map<string, ModalImpl>();
let inGame = false;

type ModalImpl = Modal & { options: ModalOptions };

/**
 * Tells the menus whether a game is running: blocked keys are only kept from
 * the engine, and the pointer lock only taken back, while it is.
 */
export function setInGame(running: boolean): void {
  inGame = running;
}

/** True while any of the menus is open. */
export function anyModalOpen(): boolean {
  return modals.some((modal) => modal.isOpen());
}

function isToggleKey(modal: ModalImpl, event: KeyboardEvent): boolean {
  const { toggleKey } = modal.options;
  return typeof toggleKey === 'string'
    ? toggleKey === event.code
    : toggleKey(event);
}

export function createModal(options: ModalOptions): Modal {
  const { backdrop, panel } = options;
  const modal: ModalImpl = {
    options,
    isOpen: () => !backdrop.hidden,
    open() {
      if (modal.isOpen() || !options.canOpen()) return;
      for (const other of modals) other.close(false);
      document.exitPointerLock?.();
      backdrop.hidden = false;
      options.onOpen();
    },
    close(relock) {
      if (!modal.isOpen()) return;
      backdrop.hidden = true;
      options.onClose?.();
      const focused = document.activeElement as HTMLElement | null;
      if (focused && panel.contains(focused)) focused.blur();
      if (relock && inGame) {
        try {
          void Promise.resolve(canvas.requestPointerLock()).catch(() => {});
        } catch {}
      }
    },
  };
  // Clicks on the backdrop close the menu; clicks on the panel don't.
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) modal.close(false);
  });
  modals.push(modal);
  return modal;
}

// Groups the panel's tabbable elements into Tab stops: a radio group is one
// stop, entered at its checked radio.
function tabStops(panel: HTMLElement): HTMLElement[][] {
  const stops: HTMLElement[][] = [];
  const radioGroups = new Map<string, HTMLElement[]>();
  for (const el of panel.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (el.tabIndex < 0 || el.offsetParent === null) continue;
    if ((el as HTMLInputElement).disabled) continue;
    if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) {
      const group = radioGroups.get(el.name);
      if (group) {
        group.push(el);
        continue;
      }
      radioGroups.set(el.name, [el]);
      stops.push(radioGroups.get(el.name)!);
      continue;
    }
    stops.push([el]);
  }
  return stops;
}

function stopTarget(stop: HTMLElement[], backwards: boolean): HTMLElement {
  return (
    stop.find((el) => (el as HTMLInputElement).checked) ??
    (backwards ? stop[stop.length - 1] : stop[0])
  );
}

// Keeps focus inside the menu: Tab past the last stop goes to the first one,
// and Shift+Tab before the first goes to the last.
function trapFocus(panel: HTMLElement, event: KeyboardEvent): void {
  const stops = tabStops(panel);
  if (stops.length === 0) {
    event.preventDefault();
    return;
  }
  const current = document.activeElement as HTMLElement | null;
  const index = stops.findIndex((stop) => stop.includes(current!));
  const backwards = event.shiftKey;
  let target: HTMLElement | undefined;
  if (index === -1) target = stopTarget(stops[0], false);
  else if (backwards && index === 0) {
    target = stopTarget(stops[stops.length - 1], true);
  } else if (!backwards && index === stops.length - 1) {
    target = stopTarget(stops[0], false);
  }
  if (target) {
    event.preventDefault();
    target.focus();
  }
}

// Registered at module load, before the engine adds its own window
// listeners, so stopImmediatePropagation keeps keys from reaching the game.
// That also keeps them from listeners inside the menus, so the menus' own
// keys go through onKeyDown. keyup is left alone so a key held when a menu
// opens is still released, except for blocked keys and the toggle keys of
// hold-to-open menus, whose keydown the engine never saw.
function onKey(event: KeyboardEvent): void {
  const current = modals.find((modal) => modal.isOpen());
  if (!current && inGame && ENGINE_BLOCKED_KEYS.has(event.code)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if (event.type === 'keydown') {
    const toggled = modals.find((modal) => isToggleKey(modal, event));
    if (toggled && (toggled === current || toggled.options.canOpen())) {
      // Also keeps browser shortcuts (F3: find) from running.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (toggled.options.onToggleKeyUp) {
        heldToggleKeys.set(event.code, toggled);
      }
      if (event.repeat) return;
      if (toggled === current) toggled.close(true);
      else toggled.open();
      return;
    }
  }
  if (!current) return;
  // Without preventDefault, typing and Enter still work in the form.
  event.stopImmediatePropagation();
  if (event.type !== 'keydown') return;
  if (event.code === 'Escape') {
    event.preventDefault();
    current.close(false);
  } else if (event.key === 'Tab') {
    trapFocus(current.options.panel, event);
  } else if (current.options.onKeyDown?.(event)) {
    event.preventDefault();
  }
}

function onKeyUp(event: KeyboardEvent): void {
  const held = heldToggleKeys.get(event.code);
  if (held) {
    heldToggleKeys.delete(event.code);
    event.stopImmediatePropagation();
    if (held.isOpen()) held.options.onToggleKeyUp?.();
    return;
  }
  if (inGame && ENGINE_BLOCKED_KEYS.has(event.code)) {
    event.stopImmediatePropagation();
  }
}

window.addEventListener('keydown', onKey, { capture: true });
window.addEventListener('keypress', onKey, { capture: true });
window.addEventListener('keyup', onKeyUp, { capture: true });
