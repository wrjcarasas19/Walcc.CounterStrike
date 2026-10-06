import { getServerMaps, syncServerMaps } from '../maps';
import { isAmxxMap, MAP_PATTERN, VOTE_MAPS_MAX } from './actions';
import {
  closeMenu,
  expectEffect,
  getEngine,
  hasPassword,
  isBusy,
  isLoggedIn,
  sendAction,
  sendApiAction,
  setStatus,
  usesApi,
  type AdminTab,
} from './core';

// Changes the map, sets the next map, or starts a map vote. A map change
// (also the one after a won vote) is confirmed by the reset event the
// client sends once the new map is loaded. The next map (amx_nextmap) can
// only be read back through the admin API.

// Covers loading a large map after the server has switched.
const CHANGE_TIMEOUT_MS = 15_000;
// amx_votemap shows the menu for amx_vote_time (10 s in amxx.cfg) + 2 s and
// runs changelevel 2 s after a win; amx_votemap_ratio is 0.40.
const VOTE_SECONDS = 12;
const VOTE_TIMEOUT_MS = (VOTE_SECONDS + 2) * 1000 + CHANGE_TIMEOUT_MS;
const VOTE_RATIO = '40%';

const panel = document.createElement('div');
panel.className = 'admin-tab-body';

const field = document.createElement('div');
field.className = 'field';
const fieldLabel = document.createElement('span');
fieldLabel.className = 'field-label';
fieldLabel.id = 'admin-maps-label';
fieldLabel.textContent = 'Map';
const mapList = document.createElement('div');
mapList.className = 'admin-maps';
mapList.setAttribute('role', 'radiogroup');
mapList.setAttribute('aria-labelledby', fieldLabel.id);
field.append(fieldLabel, mapList);

const submit = document.createElement('button');
submit.className = 'action-button';
submit.type = 'submit';
submit.disabled = true;
submit.textContent = 'Change map';

const setNext = document.createElement('button');
setNext.className = 'action-button admin-secondary';
setNext.type = 'button';
setNext.textContent = 'Set as next map';

const nextNote = document.createElement('p');
nextNote.className = 'admin-note';

const voteField = document.createElement('div');
voteField.className = 'field';
const voteLabel = document.createElement('span');
voteLabel.className = 'field-label';
voteLabel.id = 'admin-vote-label';
voteLabel.textContent = `Map vote (up to ${VOTE_MAPS_MAX} maps)`;
const votePicks = document.createElement('div');
votePicks.className = 'admin-vote-maps';
votePicks.setAttribute('role', 'group');
votePicks.setAttribute('aria-labelledby', voteLabel.id);
const voteEmpty = document.createElement('p');
voteEmpty.className = 'admin-note';
voteEmpty.textContent = 'Pick a map above, then Add to vote.';
voteField.append(voteLabel, votePicks, voteEmpty);

const voteRow = document.createElement('div');
voteRow.className = 'admin-button-row';
const addVote = document.createElement('button');
addVote.className = 'action-button admin-secondary';
addVote.type = 'button';
addVote.textContent = 'Add to vote';
const startVote = document.createElement('button');
startVote.className = 'action-button admin-secondary';
startVote.type = 'button';
startVote.textContent = 'Start vote';
voteRow.append(addVote, startVote);

const voteNote = document.createElement('p');
voteNote.className = 'admin-note';
voteNote.textContent =
  `Players get a menu for ${VOTE_SECONDS} seconds; the map changes right ` +
  `away if one map gets ${VOTE_RATIO} of the votes. Bots don't vote. ` +
  'One map asks yes or no.';

panel.append(field, submit, setNext, nextNote, voteField, voteRow, voteNote);
mapList.addEventListener('change', refresh);
setNext.addEventListener('click', () => void setNextMap());
addVote.addEventListener('click', addPick);
startVote.addEventListener('click', () => void runVote());

let shown = false;
let picks: string[] = [];
// amx_nextmap as last read (admin API only); '' = the server has none.
let nextMap: string | undefined;
let nextRequest: Promise<string | undefined> | undefined;
let nextFailed = false;
let settingNext = false;
let wasLoggedIn = false;

function selectedMap(): string | undefined {
  return mapList.querySelector<HTMLInputElement>('input:checked')?.value;
}

function refresh(): void {
  const map = selectedMap();
  const ready = !isBusy() && hasPassword();
  submit.disabled = !ready || map === undefined;
  setNext.disabled =
    !ready || settingNext || map === undefined || !isAmxxMap(map);
  addVote.disabled =
    map === undefined ||
    !isAmxxMap(map) ||
    picks.includes(map) ||
    picks.length >= VOTE_MAPS_MAX;
  startVote.disabled = !ready || picks.length === 0;
  // Read the next map once logged in (also after logging in with the tab
  // open).
  const loggedIn = isLoggedIn();
  if (shown && loggedIn && !wasLoggedIn) void loadNextMap();
  if (!loggedIn) nextMap = undefined;
  wasLoggedIn = loggedIn;
  renderNextMap();
}

function renderNextMap(): void {
  const help =
    'The next map is used when the time limit or max rounds end, instead ' +
    "of the players' end-of-map vote. After that the map cycle goes on.";
  let current = '';
  if (usesApi()) {
    if (!isLoggedIn()) current = 'Log in to see the next map.';
    else if (nextRequest) current = 'Next map: loading...';
    else if (nextFailed) current = "Couldn't read the next map.";
    else if (nextMap === '') current = 'Next map: unknown (no AMX Mod X).';
    else if (nextMap !== undefined) current = `Next map: ${nextMap}.`;
  }
  nextNote.textContent = current ? `${current} ${help}` : help;
}

function renderMaps(): void {
  const previous = selectedMap();
  const maps = getServerMaps();
  mapList.replaceChildren(
    ...maps.map((name) => {
      const option = document.createElement('label');
      option.className = 'admin-map';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'admin-map';
      radio.value = name;
      radio.checked = name === previous;
      const label = document.createElement('span');
      label.textContent = name;
      option.append(radio, label);
      return option;
    })
  );
  if (maps.length === 0) {
    setStatus("The server's map list couldn't be loaded.", true);
  } else if (picks.some((map) => !maps.includes(map))) {
    picks = picks.filter((map) => maps.includes(map));
    renderPicks();
  }
  refresh();
}

function renderPicks(focusIndex?: number): void {
  votePicks.replaceChildren(
    ...picks.map((map, i) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'admin-vote-map';
      chip.textContent = map;
      chip.title = `Remove ${map} from the vote`;
      chip.setAttribute('aria-label', chip.title);
      chip.addEventListener('click', () => removePick(i));
      return chip;
    })
  );
  voteEmpty.hidden = picks.length > 0;
  if (focusIndex !== undefined) {
    const chips = votePicks.querySelectorAll('button');
    const target =
      chips[Math.min(focusIndex, chips.length - 1)] ??
      (addVote.disabled ? null : addVote) ??
      mapList.querySelector<HTMLInputElement>('input:checked');
    target?.focus();
  }
}

function addPick(): void {
  const map = selectedMap();
  if (
    !map ||
    !isAmxxMap(map) ||
    picks.includes(map) ||
    picks.length >= VOTE_MAPS_MAX
  ) {
    return;
  }
  picks = [...picks, map];
  renderPicks();
  refresh();
  // Add to vote is disabled now (map already picked): go on to Start vote.
  if (!startVote.disabled) startVote.focus();
}

function removePick(index: number): void {
  picks = picks.filter((_, i) => i !== index);
  refresh();
  renderPicks(index);
}

function show(): void {
  shown = true;
  renderMaps();
  if (isLoggedIn()) void loadNextMap();
  // Picks up maps added to the server since the last sync.
  const engine = getEngine();
  if (engine) {
    void syncServerMaps(engine).then(() => {
      // offsetParent is null while the panel or the menu is hidden.
      if (panel.offsetParent !== null) renderMaps();
    });
  }
}

function hide(): void {
  shown = false;
}

/**
 * Reads amx_nextmap through the admin API (undefined if not sent or
 * failed). Joins a read in flight unless fresh (after setting it).
 */
function loadNextMap(fresh = false): Promise<string | undefined> {
  if (nextRequest && !fresh) return nextRequest;
  const request = sendApiAction({ action: 'nextmap' });
  if (!request) return Promise.resolve(undefined);
  const read = request.then((result) => {
    if (nextRequest === read) {
      nextRequest = undefined;
      nextFailed = result === undefined;
      if (result) nextMap = result.nextMap;
      renderNextMap();
    }
    return result?.nextMap;
  });
  nextRequest = read;
  renderNextMap();
  return read;
}

async function setNextMap(): Promise<void> {
  const map = selectedMap();
  if (isBusy() || settingNext || !map || !isAmxxMap(map)) return;
  if (!sendAction({ action: 'set_nextmap', map })) return;
  if (!usesApi()) {
    // Rcon gives no answer to check.
    setStatus(`Sent: the next map should now be ${map}.`);
    return;
  }
  settingNext = true;
  refresh();
  setStatus(`Setting the next map to ${map}...`);
  // Queued after the set; dropped (undefined) if the set failed, and the
  // status line already says why.
  const now = await loadNextMap(true);
  settingNext = false;
  refresh();
  if (now === map) {
    setStatus(`Done. The next map is ${map}.`);
  } else if (now !== undefined) {
    setStatus(
      `The server's next map is still ${now || 'unknown'}. Is AMX Mod X running?`,
      true
    );
  }
}

async function runVote(): Promise<void> {
  if (isBusy() || picks.length === 0) return;
  const maps = [...picks];
  if (!sendAction({ action: 'votemap', maps })) return;
  setStatus(
    `Vote on ${maps.join(', ')}: players have ${VOTE_SECONDS} seconds. ` +
      'Close this menu to vote too.'
  );
  const result = await expectEffect(
    (event) => event.type === 'reset',
    VOTE_TIMEOUT_MS
  );
  if (result === 'done') {
    setStatus('');
    closeMenu();
  } else if (result === 'timeout') {
    setStatus(
      "The vote didn't change the map: nobody voted, or no map got " +
        `${VOTE_RATIO} of the votes` +
        (usesApi() ? '.' : ', or the password is wrong.'),
      true
    );
  }
}

async function changeMap(): Promise<void> {
  const map = selectedMap();
  if (isBusy() || !map) return;
  // Names come from the server's listing, but they are pasted into a
  // command line.
  if (!MAP_PATTERN.test(map)) return;
  if (!sendAction({ action: 'changelevel', map })) return;
  setStatus(`Changing to ${map}...`);
  const result = await expectEffect(
    (event) => event.type === 'reset',
    CHANGE_TIMEOUT_MS
  );
  if (result === 'done') {
    setStatus('');
    closeMenu();
  } else if (result === 'timeout') {
    setStatus(
      "The server didn't change the map. Check the password and try again.",
      true
    );
  }
}

renderPicks();
renderNextMap();

export const mapTab: AdminTab = {
  id: 'map',
  label: 'Map',
  panel,
  show,
  hide,
  submit: () => void changeMap(),
  refresh,
  focusTarget: () =>
    mapList.querySelector<HTMLInputElement>('input:checked') ??
    mapList.querySelector<HTMLInputElement>('input'),
};
