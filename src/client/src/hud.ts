import type { Xash3D } from 'xash3d-fwgs';

// HTML replacement for part of the stock HUD. The game client (cs16-client,
// web_bridge.cpp) calls Module.hudEvent(type, payload); the payloads are
// documented in web_bridge.h. With hud_html 1 the client skips drawing the
// elements rendered here.

type Team = 'CT' | 'T' | '';

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
      };
    }
  | { type: 'alive'; payload: { alive: boolean; spectating: boolean } }
  | { type: 'reset'; payload: Record<string, never> };

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

const headshotIcon = document.createElementNS(
  'http://www.w3.org/2000/svg',
  'svg'
);
headshotIcon.setAttribute('class', 'hud-icon');
headshotIcon.setAttribute('viewBox', '0 0 24 24');
headshotIcon.innerHTML =
  '<path fill-rule="evenodd" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm0 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/>';

// Largest clip seen per weapon, used as its magazine size for low ammo.
const maxClip = new Map<string, number>();

const killTimers = new Set<ReturnType<typeof setTimeout>>();

let engine: Xash3D | undefined;
let bridgeSeen = false;
let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
// The first money change after a reset is the server syncing the balance
// (+$800 on connect, the new map's start money), not a purchase or reward.
let moneySynced = false;

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

function later(fn: () => void, ms: number): void {
  const id = setTimeout(() => {
    killTimers.delete(id);
    fn();
  }, ms);
  killTimers.add(id);
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
  later(() => {
    row.classList.add('fading');
    later(() => row.remove(), KILL_FADE_MS);
  }, KILL_TTL_MS);
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
  maxClip.clear();
  // Vitals and ammo stay hidden until the first alive event (sent the frame
  // after connect, or right after a reset's resend), so a player joining
  // mid-round as a spectator never sees them flash.
  hud.dataset.alive = 'unknown';
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
      break;
    }
    case 'kill':
      addKill(event.payload);
      break;
    case 'alive': {
      const { alive, spectating } = event.payload;
      // Health and armor still describe the local player while spectating.
      const shown = alive && !spectating ? 'true' : 'false';
      if (hud.dataset.alive !== shown) hud.dataset.alive = shown;
      break;
    }
    case 'reset':
      reset();
      break;
  }
}

// engine.em is a wrapper ({ Module, FS, HEAPU8, ... }); the client's EM_JS
// code reads hudEvent from the Emscripten Module inside it.
function bridgeModule(target: Xash3D): HudModule {
  return target.em!.Module as HudModule;
}

function setHudEnabled(enabled: boolean): void {
  hud.hidden = !enabled;
  engine?.Cmd_ExecuteString(`hud_html ${enabled ? 1 : 0}`);
}

function onBridgeEvent(type: string, payload: unknown): void {
  if (!bridgeSeen) {
    bridgeSeen = true;
    clearTimeout(fallbackTimer);
    // Events can still show up after a slow connect fell back.
    if (hud.hidden) setHudEnabled(true);
  }
  handle({ type, payload } as HudEvent);
}

// Dims the HUD while Tab (the default +showscores key) is held so the native
// scoreboard reads cleanly. Only while the game has the pointer, so Tab in the
// console or menus is ignored. The event is not consumed; a rebound
// scoreboard key is not detected.
function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Tab') return;
  const held = event.type === 'keydown' && !!document.pointerLockElement;
  hud.classList.toggle('dimmed', held);
}

function undim(): void {
  hud.classList.remove('dimmed');
}

/**
 * Shows the HTML HUD and hides the stock elements it replaces. Call after
 * engine.main() and before connecting, so no bridge event is missed.
 */
export function attachHud(target: Xash3D): void {
  detachHud();
  engine = target;
  bridgeModule(target).hudEvent = onBridgeEvent;
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', undim);
  setHudEnabled(true);
  fallbackTimer = setTimeout(() => {
    if (!bridgeSeen) setHudEnabled(false);
  }, FALLBACK_MS);
}

/** Hides the HUD and stops all its timers and listeners (connection lost). */
export function detachHud(): void {
  if (!engine) return;
  delete bridgeModule(engine).hudEvent;
  engine = undefined;
  bridgeSeen = false;
  clearTimeout(fallbackTimer);
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('keyup', onKey);
  window.removeEventListener('blur', undim);
  reset();
  undim();
  hud.hidden = true;
}
