import {
  getLatestScores,
  isScoreboardOpen,
  onHudEvent,
  redrawScores,
  setLiveScores,
  setScoreVoice,
  type ScorePlayer,
} from './hud';
import { getSettings, onSettingsChange } from './settings/store';
import {
  adminMutedUserids,
  isTalking,
  isTalkingToAll,
  laneSpeakers,
  onVoiceEvent,
  setPlayerGain,
  talksToAll,
  usesTouchControls,
  voiceOffered,
} from './voice';

// Speaking indicators and mutes (new-features-1007 A.5).
//
// - The speaking list (#hud-voice), on the left just above the chat feed:
//   whoever is heard on a voice lane (voice.ts lane events; the server only
//   sends what this player may hear) while their packets arrive, with a
//   sound icon, plus the local player with a microphone icon while sending
//   (a crossed-out one when the admin has muted them). Locally muted
//   players aren't listed. Someone talking to all players (A.7: the
//   talk-to-all key), the local player included, has an "[All]" tag.
//   Names and team colours
//   come from the scoreboard snapshots (`scores`, by engine userid), which
//   the client sends every 0.5 s while voice is on and offered
//   (setLiveScores).
// - The scoreboard's voice cell: a speaker while that player is heard (or,
//   for the local player, sending), a crossed-out microphone when the admin
//   has muted them (everyone sees it), and a mute button. Mutes are this
//   browser's own, remembered by name in localStorage, and play the
//   player's lanes at gain 0 (voice.ts setPlayerGain).
// - The scoreboard never takes the mouse while the game has the pointer
//   locked; as in CS 1.6, a right click while it is open frees the pointer
//   and the mute buttons can be clicked (touch: tap them).

const STORAGE_KEY = 'voice-mutes';
/** The oldest mutes are dropped past this many names. */
const MAX_MUTES = 200;
const SVG = 'http://www.w3.org/2000/svg';

const SPEAKER = 'M3 9h4l5-4v14l-5-4H3z';
const ICONS = {
  sound: `${SPEAKER}M14 7.5v9a4.5 4.5 0 0 0 0-9zm0-4v2.1a6.5 6.5 0 0 1 0 12.8v2.1a8.5 8.5 0 0 0 0-17z`,
  speaker: `${SPEAKER}M14 8.5v7a3.5 3.5 0 0 0 0-7z`,
  speakerOff: `${SPEAKER}M14.6 10l1.4-1.4 2 2 2-2 1.4 1.4-2 2 2 2-1.4 1.4-2-2-2 2-1.4-1.4 2-2z`,
  mic: 'M12 2a3.5 3.5 0 0 0-3.5 3.5v6a3.5 3.5 0 0 0 7 0v-6A3.5 3.5 0 0 0 12 2zM5 11h2a5 5 0 0 0 10 0h2a7 7 0 0 1-6 6.9V21h3v2H8v-2h3v-3.1A7 7 0 0 1 5 11z',
  micOff:
    'M12 2a3.5 3.5 0 0 0-3.5 3.5v6a3.5 3.5 0 0 0 7 0v-6A3.5 3.5 0 0 0 12 2zM5 11h2a5 5 0 0 0 10 0h2a7 7 0 0 1-6 6.9V21h3v2H8v-2h3v-3.1A7 7 0 0 1 5 11zM3.3 4.7l1.4-1.4 16 16-1.4 1.4z',
} as const;

type IconName = keyof typeof ICONS;

type Person = {
  name: string;
  team: ScorePlayer['team'];
  local: boolean;
  bot: boolean;
};

const hud = document.getElementById('hud')!;
const list = document.getElementById('hud-voice')!;
const chatFeed = document.getElementById('hud-chat')!;
const hint = document.getElementById('sb-voice-hint')!;

/** Engine userid -> player, from the last scores snapshot. */
let people = new Map<number, Person>();
let peopleKey = '';
let mutes = loadMutes();
/** Userids heard now, in the order they started. */
let speaking: number[] = [];
let lastList = '';
/** The scoreboard takes clicks on its mute buttons. */
let pointerFree = false;
/** A right click freed the pointer: its mouseup is kept from the game too. */
let swallowRightUp = false;

function icon(name: IconName, className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

// --- Mutes, by name --------------------------------------------------------

function loadMutes(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? '[]'
    );
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((name): name is string => typeof name === 'string' && !!name)
      .slice(-MAX_MUTES);
  } catch {
    return [];
  }
}

function saveMutes(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mutes));
  } catch {
    // Private mode or storage full: the mutes still apply until reload.
  }
}

function isMuted(name: string): boolean {
  return mutes.includes(name);
}

function toggleMute(name: string): void {
  mutes = isMuted(name)
    ? mutes.filter((muted) => muted !== name)
    : [...mutes, name].slice(-MAX_MUTES);
  saveMutes();
  applyGains();
  renderList();
  redrawScores();
}

function applyGains(): void {
  setPlayerGain((userid) => {
    const person = people.get(userid);
    return person && isMuted(person.name) ? 0 : 1;
  });
}

// --- Who is who --------------------------------------------------------

function updatePeople(players: readonly ScorePlayer[]): void {
  const next = new Map<number, Person>();
  for (const player of players) {
    if (!player.userid) continue;
    next.set(player.userid, {
      name: player.name,
      team: player.team,
      local: player.local,
      bot: player.bot,
    });
  }
  const key = JSON.stringify([...next]);
  if (key === peopleKey) return;
  peopleKey = key;
  people = next;
  // A muted name may have a new userid (reconnect), or a userid a new name.
  applyGains();
  renderList();
}

function localPerson(): Person | undefined {
  for (const person of people.values()) if (person.local) return person;
  return undefined;
}

function localUserid(): number {
  for (const [userid, person] of people) if (person.local) return userid;
  return 0;
}

function teamClass(team: Person['team'] | undefined): string {
  return team === 'CT' ? 'ct' : team === 'T' ? 't' : 'spec';
}

// --- The speaking list ---------------------------------------------------

function allTag(className: string): HTMLElement {
  const tag = document.createElement('span');
  tag.className = className;
  tag.textContent = '[All]';
  tag.title = 'Talking to all players';
  return tag;
}

function entry(
  name: string,
  team: Person['team'] | undefined,
  iconName: IconName,
  extra: string,
  all: boolean
): HTMLElement {
  const row = document.createElement('div');
  row.className = `hud-voice-entry ${teamClass(team)}${extra}`;
  const label = document.createElement('span');
  label.className = 'hud-voice-name';
  label.textContent = name;
  row.append(icon(iconName, 'hud-voice-icon'));
  if (all) row.append(allTag('hud-voice-all'));
  row.append(label);
  return row;
}

function renderList(): void {
  const entries: [
    string,
    Person['team'] | undefined,
    IconName,
    string,
    boolean,
  ][] = [];
  const self = localUserid();
  if (isTalking()) {
    const me = localPerson();
    const muted = self !== 0 && adminMutedUserids().includes(self);
    entries.push([
      me?.name ?? 'You',
      me?.team,
      muted ? 'micOff' : 'mic',
      muted ? ' local admin-muted' : ' local',
      isTalkingToAll(),
    ]);
  }
  for (const userid of speaking) {
    if (userid === self) continue;
    const person = people.get(userid);
    // Muted players aren't heard, so they aren't listed.
    if (person && isMuted(person.name)) continue;
    entries.push([
      person?.name ?? `Player #${userid}`,
      person?.team,
      'sound',
      '',
      talksToAll(userid),
    ]);
  }
  const key = JSON.stringify(entries);
  if (key === lastList) return;
  lastList = key;
  list.replaceChildren(
    ...entries.map(([name, team, iconName, extra, all]) =>
      entry(name, team, iconName, extra, all)
    )
  );
  placeList();
}

/** Keeps the list just above the chat feed, wherever that is now. */
function placeList(): void {
  if (list.childElementCount === 0) return;
  const hudBox = hud.getBoundingClientRect();
  const chatTop = chatFeed.getBoundingClientRect().top;
  const bottom = Math.max(0, hudBox.bottom - chatTop);
  list.style.bottom = `${Math.round(bottom)}px`;
}

// The chat feed grows and shrinks with its lines, and moves when the chat
// input or the on-screen keyboard opens (classes on #hud).
new ResizeObserver(placeList).observe(chatFeed);
new ResizeObserver(placeList).observe(hud);
new MutationObserver(placeList).observe(hud, {
  attributes: true,
  attributeFilter: ['class', 'style'],
});

function updateSpeaking(): void {
  const now = laneSpeakers(true).filter((userid) => userid > 0);
  speaking = [
    ...speaking.filter((userid) => now.includes(userid)),
    ...now.filter((userid) => !speaking.includes(userid)),
  ].filter((userid, index, all) => all.indexOf(userid) === index);
}

onVoiceEvent((event) => {
  if (event.type === 'offered') applySettings();
  if (event.type === 'lane') updateSpeaking();
  renderList();
  redrawScores();
});

// --- The scoreboard's voice cell -----------------------------------------

function fillVoiceCell(player: ScorePlayer, cell: HTMLElement): void {
  if (!voiceOffered() || player.bot) return;
  const userid = player.userid ?? 0;
  if (userid && adminMutedUserids().includes(userid)) {
    const muted = icon('micOff', 'sb-voice-icon admin-muted');
    cell.title = 'Voice muted by the admin';
    cell.append(muted);
  } else if (
    player.local ? isTalking() : userid !== 0 && speaking.includes(userid)
  ) {
    if (player.local || !isMuted(player.name)) {
      const all = player.local ? isTalkingToAll() : talksToAll(userid);
      if (all) {
        cell.append(allTag('sb-voice-all'));
        cell.title = 'Talking to all players';
      }
      cell.append(icon('sound', `sb-voice-icon speaking${all ? ' all' : ''}`));
    }
  }
  if (player.local) return;
  const muted = isMuted(player.name);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = muted ? 'sb-mute muted' : 'sb-mute';
  button.dataset.name = player.name;
  button.tabIndex = -1;
  button.setAttribute('aria-pressed', String(muted));
  button.setAttribute(
    'aria-label',
    `${muted ? 'Unmute' : 'Mute'} ${player.name}`
  );
  button.title = muted ? 'Unmute' : 'Mute';
  button.append(icon(muted ? 'speakerOff' : 'speaker', 'sb-voice-icon'));
  cell.append(button);
}

setScoreVoice(fillVoiceCell);

// Rows are rebuilt with each snapshot, so the press is handled on
// pointerdown (a click could end on a new row) and found by name.
document
  .getElementById('hud-scoreboard')!
  .addEventListener('pointerdown', (event) => {
    const button = (event.target as Element).closest<HTMLElement>('.sb-mute');
    if (!button?.dataset.name || !pointerFree) return;
    // Not a shot for the game, and no focus left on the button.
    event.preventDefault();
    event.stopPropagation();
    toggleMute(button.dataset.name);
  });

function updatePointer(): void {
  const open = isScoreboardOpen() && voiceOffered();
  // Touches aren't held by the pointer lock (which a phone's browser may
  // still have granted on a tap).
  pointerFree = open && (!document.pointerLockElement || usesTouchControls());
  hud.classList.toggle('sb-pointer', pointerFree);
  const others = [...people.values()].some(
    (person) => !person.local && !person.bot
  );
  hint.hidden = !open || pointerFree || !others;
}

document.addEventListener('pointerlockchange', updatePointer);

// With the scoreboard open, a right click frees the pointer (and isn't a
// secondary attack). Registered on window in the capture phase, before the
// engine's own mouse listeners on the canvas.
window.addEventListener(
  'mousedown',
  (event) => {
    if (
      event.button !== 2 ||
      !isScoreboardOpen() ||
      !voiceOffered() ||
      !document.pointerLockElement
    ) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    swallowRightUp = true;
    document.exitPointerLock?.();
  },
  { capture: true }
);

window.addEventListener(
  'mouseup',
  (event) => {
    if (event.button !== 2 || !swallowRightUp) return;
    swallowRightUp = false;
    event.stopImmediatePropagation();
  },
  { capture: true }
);

window.addEventListener(
  'contextmenu',
  (event) => {
    if (isScoreboardOpen()) event.preventDefault();
  },
  { capture: true }
);

// --- Wiring ----------------------------------------------------------------

onHudEvent((event) => {
  switch (event.type) {
    case 'scores':
      updatePeople(event.payload.players);
      updatePointer();
      break;
    case 'scoreboard':
    case 'reset':
      updatePointer();
      break;
  }
});

/**
 * Scores (names, teams) come all the time while voice is on and the
 * server offers it.
 */
function applySettings(): void {
  setLiveScores('voice', getSettings().voiceEnabled && voiceOffered());
}

applySettings();
onSettingsChange((_settings, changed) => {
  if (changed.includes('voiceEnabled')) applySettings();
});

const latest = getLatestScores();
if (latest) updatePeople(latest.players);
applyGains();
