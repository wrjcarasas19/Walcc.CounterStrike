import {
  onHudEvent,
  setLiveScores,
  type HudEvent,
  type ScorePlayer,
  type Scores,
} from '../hud';
import {
  expectEffect,
  hasPassword,
  isBusy,
  isLoggedIn,
  sendAction,
  sendApiAction,
  setStatus,
  usesApi,
  type AdminTab,
  type BanEntry,
} from './core';

// Lists the players from the latest `scores` HUD event and kicks them with
// `kick #<userid>`. The userid is a number from the client, so no name ever
// goes into the command line. While the tab is shown (or a kick waits for its
// effect) the client is asked to send scores every 0.5 s, and a kick is
// confirmed by a snapshot that no longer has the player.
//
// With the admin API, Ban kicks the player and bans their real address on
// the Go server (the page only sends the userid and the slot), and the tab
// lists the banned addresses with an Unban button. Over rcon there are no
// bans: the engine only sees fake addresses (see src/server/bans.go).

// The server drops the player on its next frame; the rest covers the 0.5 s
// snapshot interval and the round trip.
const KICK_TIMEOUT_MS = 5_000;
const KICK_COMMAND_PATTERN = /^kick #[1-9][0-9]{0,9}$/;

const TEAM_ORDER: Record<ScorePlayer['team'], number> = {
  CT: 0,
  T: 1,
  SPEC: 2,
  '': 3,
};
const TEAM_TEXT: Record<ScorePlayer['team'], string> = {
  CT: 'CT',
  T: 'T',
  SPEC: 'Spec',
  '': '-',
};

type Row = {
  el: HTMLElement;
  name: HTMLElement;
  tags: HTMLElement;
  team: HTMLElement;
  frags: HTMLElement;
  actions: HTMLElement;
  kick: HTMLButtonElement;
  ban: HTMLButtonElement;
  confirm: HTMLElement;
  confirmText: HTMLElement;
  confirmButton: HTMLButtonElement;
  cancel: HTMLButtonElement;
  player: ScorePlayer;
};

type Removal = 'kick' | 'ban';

const panel = document.createElement('div');
panel.className = 'admin-tab-body';

const field = document.createElement('div');
field.className = 'field';
const fieldLabel = document.createElement('span');
fieldLabel.className = 'field-label';
fieldLabel.id = 'admin-players-label';
fieldLabel.textContent = 'Players';
const list = document.createElement('div');
list.className = 'admin-players';
list.setAttribute('role', 'list');
list.setAttribute('aria-labelledby', fieldLabel.id);
// Holds focus when the focused button goes away (a kicked player's row, a
// closed confirmation); not a Tab stop.
list.tabIndex = -1;
const note = document.createElement('p');
note.className = 'admin-note';
field.append(fieldLabel, list, note);

// Banned addresses (admin API only).
const bansField = document.createElement('div');
bansField.className = 'field';
const bansLabel = document.createElement('span');
bansLabel.className = 'field-label';
bansLabel.id = 'admin-bans-label';
bansLabel.textContent = 'Banned addresses';
const bansList = document.createElement('div');
bansList.className = 'admin-players admin-bans';
bansList.setAttribute('role', 'list');
bansList.setAttribute('aria-labelledby', bansLabel.id);
bansList.tabIndex = -1;
const bansNote = document.createElement('p');
bansNote.className = 'admin-note';
bansField.append(bansLabel, bansList, bansNote);
panel.append(field, bansField);

// Rows by key (userid, or the slot when the client sends no userid), reused
// across snapshots so focus and the open confirmation survive updates.
const rows = new Map<string, Row>();
let latest: Scores | undefined;
let lastRendered = '';
let shown = false;
// The row whose confirmation is open (by userid), and for what.
let confirming: { userid: number; kind: Removal } | undefined;
// userid being kicked or banned, until its effect settles.
let kicking: number | undefined;
// The ban list from the server; undefined until loaded (or not logged in).
let bansLoaded: BanEntry[] | undefined;
let bansLoading = false;
let bansError = '';
// An unban request is on its way.
let unbanning = false;
// Logged in when the tab last refreshed, to load the bans after a login.
let wasLoggedIn = false;

onHudEvent(trackEvent);

function trackEvent(event: HudEvent): void {
  if (event.type !== 'scores') return;
  latest = event.payload;
  if (shown) render();
}

function rowKey(player: ScorePlayer): string {
  return validUserid(player) ? `u${player.userid}` : `s${player.id}`;
}

function validUserid(player: ScorePlayer): boolean {
  const { userid } = player;
  return (
    typeof userid === 'number' && Number.isSafeInteger(userid) && userid > 0
  );
}

// Not by frags: rows shouldn't move under the pointer while the list updates.
function byTeamAndName(a: ScorePlayer, b: ScorePlayer): number {
  return (
    TEAM_ORDER[a.team] - TEAM_ORDER[b.team] ||
    a.name.localeCompare(b.name) ||
    a.id - b.id
  );
}

function teamClass(team: ScorePlayer['team']): string {
  return team === 'CT' ? 'ct' : team === 'T' ? 't' : '';
}

function smallButton(text: string, className: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `admin-player-button ${className}`;
  button.textContent = text;
  return button;
}

function createRow(player: ScorePlayer): Row {
  const el = document.createElement('div');
  el.className = 'admin-player';
  el.setAttribute('role', 'listitem');

  const name = document.createElement('span');
  name.className = 'admin-player-name';
  const tags = document.createElement('span');
  tags.className = 'admin-player-tags';
  const who = document.createElement('span');
  who.className = 'admin-player-who';
  who.append(name, tags);

  const team = document.createElement('span');
  team.className = 'admin-player-team';
  const frags = document.createElement('span');
  frags.className = 'admin-player-frags';

  const kick = smallButton('Kick', 'admin-player-kick');
  const ban = smallButton('Ban', 'admin-player-ban');
  const actions = document.createElement('span');
  actions.className = 'admin-player-actions';
  actions.append(kick, ban);

  const confirm = document.createElement('div');
  confirm.className = 'admin-player-confirm';
  confirm.hidden = true;
  const confirmText = document.createElement('span');
  confirmText.className = 'admin-player-confirm-text';
  const confirmButton = smallButton('Kick', 'danger');
  const cancel = smallButton('Cancel', '');
  confirm.append(confirmText, confirmButton, cancel);

  el.append(who, team, frags, actions, confirm);

  const row: Row = {
    el,
    name,
    tags,
    team,
    frags,
    actions,
    kick,
    ban,
    confirm,
    confirmText,
    confirmButton,
    cancel,
    player,
  };
  kick.addEventListener('click', () => openConfirm(row, 'kick'));
  ban.addEventListener('click', () => openConfirm(row, 'ban'));
  cancel.addEventListener('click', () =>
    closeConfirm(confirming?.kind === 'ban' ? row.ban : row.kick)
  );
  confirmButton.addEventListener('click', () => {
    if (confirming?.kind === 'ban') void banPlayer(row.player);
    else void kickPlayer(row.player);
  });
  return row;
}

function updateRow(row: Row, player: ScorePlayer): void {
  row.player = player;
  setText(row.name, player.name);
  row.name.title = player.name;
  const tags = [player.local ? 'You' : '', player.bot ? 'Bot' : '']
    .filter(Boolean)
    .join(' · ');
  setText(row.tags, tags);
  row.tags.hidden = tags === '';
  setText(row.team, TEAM_TEXT[player.team]);
  row.team.className = `admin-player-team ${teamClass(player.team)}`;
  setText(row.frags, String(player.frags));
  row.el.classList.toggle('local', player.local);
  const kind =
    confirming !== undefined && player.userid === confirming.userid
      ? confirming.kind
      : undefined;
  row.confirm.hidden = kind === undefined;
  row.actions.hidden = kind !== undefined;
  setText(
    row.confirmText,
    kind === 'ban'
      ? `Ban ${player.name} and their address?`
      : `Kick ${player.name}?`
  );
  setText(row.confirmButton, kind === 'ban' ? 'Ban' : 'Kick');
  row.confirmButton.setAttribute(
    'aria-label',
    `Confirm: ${kind === 'ban' ? 'ban' : 'kick'} ${player.name}`
  );
  row.kick.title = kickBlocker(player) ?? `Kick ${player.name}`;
  row.kick.setAttribute('aria-label', `Kick ${player.name}`);
  row.ban.title =
    banBlocker(player) ?? `Kick ${player.name} and ban their address`;
  row.ban.setAttribute('aria-label', `Ban ${player.name}`);
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Why this player can't be kicked from the list, or undefined if they can. */
function kickBlocker(player: ScorePlayer): string | undefined {
  if (player.local) return "You can't kick yourself";
  if (!validUserid(player)) {
    return "This game client doesn't send player ids";
  }
  return undefined;
}

/** Why this player can't be banned from the list, or undefined if they can. */
function banBlocker(player: ScorePlayer): string | undefined {
  const blocker = kickBlocker(player);
  if (blocker) return blocker.replace('kick', 'ban');
  if (player.bot) return "Bots can't be banned; use the Bots tab";
  if (!usesApi()) {
    return 'Banning needs the admin API (ADMIN_PASSWORD on the server)';
  }
  return undefined;
}

function render(): void {
  const scores = latest;
  const players = scores ? [...scores.players].sort(byTeamAndName) : [];
  // The confirmation closes if its player left.
  const open = confirming;
  if (
    open !== undefined &&
    !players.some((player) => player.userid === open.userid)
  ) {
    confirming = undefined;
  }
  // Skip identical snapshots (2 Hz) unless the busy state etc. changed,
  // which refresh() handles on its own.
  const key = JSON.stringify([players, confirming]);
  if (key !== lastRendered) {
    lastRendered = key;
    // Moving a focused element out of the document blurs it; put it back.
    const focused = document.activeElement as HTMLElement | null;
    const seen = new Set<string>();
    const ordered: HTMLElement[] = [];
    for (const player of players) {
      const id = rowKey(player);
      seen.add(id);
      let row = rows.get(id);
      if (!row) {
        row = createRow(player);
        rows.set(id, row);
      }
      updateRow(row, player);
      ordered.push(row.el);
    }
    for (const id of [...rows.keys()]) {
      if (!seen.has(id)) rows.delete(id);
    }
    const current = [...list.children];
    if (
      current.length !== ordered.length ||
      current.some((el, i) => el !== ordered[i])
    ) {
      list.replaceChildren(...ordered);
      if (focused && !focused.isConnected) {
        // The focused row is gone: keep focus in the menu.
        list.focus();
      } else if (focused && document.activeElement !== focused) {
        focused.focus();
      }
    }
    renderNote(scores, players);
  }
  refresh();
}

function renderNote(scores: Scores | undefined, players: ScorePlayer[]): void {
  let text: string;
  if (!scores) text = 'Waiting for the player list from the game...';
  else if (players.length === 0) text = 'No players on the server.';
  else {
    const humans = players.filter((player) => !player.bot).length;
    const bots = players.length - humans;
    text = `${humans} ${humans === 1 ? 'player' : 'players'}`;
    if (bots > 0) text += `, ${bots} ${bots === 1 ? 'bot' : 'bots'}`;
    text += '. Updates live.';
    if (players.some((player) => !player.local && !validUserid(player))) {
      text +=
        " Kicking needs cs16-client 0.0.6 or later, which sends each player's userid.";
    }
  }
  if (!usesApi()) {
    text +=
      ' Banning needs the admin API: set ADMIN_PASSWORD on the server (rcon only sees fake addresses).';
  }
  setText(note, text);
}

// Rows of the ban list by address, rebuilt when the list changes.
let renderedBans = '';

function renderBans(): void {
  bansField.hidden = !usesApi();
  if (bansField.hidden) return;
  let text = '';
  if (!isLoggedIn()) text = 'Log in to see the banned addresses.';
  else if (bansError) text = bansError;
  else if (!bansLoaded) text = 'Loading...';
  else if (bansLoaded.length === 0) text = 'Nobody is banned.';
  else {
    text =
      'Bans are by address (IPv6: the whole /64). Players behind the same address are banned too.';
  }
  setText(bansNote, text);
  bansNote.classList.toggle('error', bansError !== '');

  const bans = isLoggedIn() ? (bansLoaded ?? []) : [];
  const key = JSON.stringify(bans);
  if (key === renderedBans) return;
  renderedBans = key;
  const focused = document.activeElement as HTMLElement | null;
  const hadFocus = focused !== null && bansList.contains(focused);
  bansList.replaceChildren(...bans.map(banRow));
  bansList.hidden = bans.length === 0;
  if (hadFocus) bansList.focus();
}

function banRow(ban: BanEntry): HTMLElement {
  const el = document.createElement('div');
  el.className = 'admin-player admin-ban';
  el.setAttribute('role', 'listitem');
  const who = document.createElement('span');
  who.className = 'admin-player-who';
  const address = document.createElement('span');
  address.className = 'admin-player-name';
  address.textContent = ban.address;
  address.title = ban.address;
  const details = document.createElement('span');
  details.className = 'admin-player-tags admin-ban-details';
  const when = new Date(ban.bannedAt);
  details.textContent = [
    ban.name,
    Number.isNaN(when.getTime()) ? '' : when.toLocaleDateString(),
  ]
    .filter(Boolean)
    .join(' · ');
  details.title = details.textContent;
  who.append(address, details);
  const unban = smallButton('Unban', 'admin-ban-unban');
  unban.setAttribute('aria-label', `Unban ${ban.address}`);
  unban.addEventListener('click', () => void unbanAddress(ban));
  el.append(who, unban);
  return el;
}

// The mode the rows and the note were last rendered for.
let renderedApi: boolean | undefined;

function refresh(): void {
  // The server's mode (API or rcon) decides whether Ban shows at all.
  if (shown && usesApi() !== renderedApi) {
    renderedApi = usesApi();
    lastRendered = '';
    render();
    return;
  }
  for (const row of rows.values()) {
    const blocked = kickBlocker(row.player) !== undefined;
    row.kick.disabled = blocked || isBusy() || !hasPassword();
    row.ban.hidden = !usesApi();
    row.ban.disabled =
      banBlocker(row.player) !== undefined || isBusy() || !hasPassword();
    row.confirmButton.disabled =
      confirming?.kind === 'ban' ? row.ban.disabled : row.kick.disabled;
  }
  // Load the list once logged in (also after logging in with the tab open).
  const loggedIn = isLoggedIn();
  if (shown && loggedIn && !wasLoggedIn) void loadBans();
  if (!loggedIn) bansLoaded = undefined;
  wasLoggedIn = loggedIn;
  renderBans();
  for (const button of bansList.querySelectorAll('button')) {
    button.disabled = unbanning || !loggedIn;
  }
}

function openConfirm(row: Row, kind: Removal): void {
  const button = kind === 'ban' ? row.ban : row.kick;
  if (button.disabled || !validUserid(row.player)) return;
  confirming = { userid: row.player.userid!, kind };
  render();
  // Cancel is the safe default for Enter / Space.
  row.cancel.focus();
}

function closeConfirm(focusTarget?: HTMLElement): void {
  confirming = undefined;
  render();
  focusTarget?.focus();
}

function updateLive(): void {
  setLiveScores('admin-players', shown || kicking !== undefined);
}

async function kickPlayer(player: ScorePlayer): Promise<void> {
  if (isBusy() || kickBlocker(player) !== undefined) return;
  const userid = player.userid!;
  const command = `kick #${userid}`;
  // userid is a number from the client; this only catches a mistake.
  if (!KICK_COMMAND_PATTERN.test(command)) return;
  if (!sendAction({ action: 'kick', userid })) return;
  confirming = undefined;
  kicking = userid;
  updateLive();
  setStatus(`Kicking ${player.name}...`);
  render();
  // The confirmation closed and the row's buttons are disabled while busy.
  list.focus();
  // A later snapshot without the userid; a reconnect gets a new userid.
  const result = await expectEffect(
    (event) =>
      event.type === 'scores' &&
      !event.payload.players.some((p) => p.userid === userid),
    KICK_TIMEOUT_MS
  );
  kicking = undefined;
  updateLive();
  if (result === 'done') {
    setStatus(`Done. ${player.name} was kicked.`);
  } else if (result === 'timeout') {
    setStatus(
      `${player.name} is still on the server. Check the password and try again.`,
      true
    );
  }
}

async function banPlayer(player: ScorePlayer): Promise<void> {
  if (isBusy() || banBlocker(player) !== undefined) return;
  const userid = player.userid!;
  // The server finds the player's address from the slot (ScorePlayer.id)
  // and checks it with the userid.
  const request = sendApiAction({ action: 'ban', userid, slot: player.id });
  if (!request) return;
  confirming = undefined;
  kicking = userid;
  updateLive();
  setStatus(`Banning ${player.name}...`);
  render();
  list.focus();
  // A failed request cancels the effect (the status line says why).
  const [result, effect] = await Promise.all([
    request,
    expectEffect(
      (event) =>
        event.type === 'scores' &&
        !event.payload.players.some((p) => p.userid === userid),
      KICK_TIMEOUT_MS
    ),
  ]);
  kicking = undefined;
  updateLive();
  if (result) {
    bansLoaded = result.bans;
    bansError = '';
    renderBans();
    refresh();
  }
  if (effect === 'done') {
    setStatus(`Done. ${player.name} was kicked and banned.`);
  } else if (effect === 'timeout' && result) {
    setStatus(
      `${player.name} was banned, but the player list hasn't updated yet.`
    );
  }
}

async function unbanAddress(ban: BanEntry): Promise<void> {
  if (unbanning) return;
  const request = sendApiAction({ action: 'unban', address: ban.address });
  if (!request) return;
  unbanning = true;
  refresh();
  setStatus(`Unbanning ${ban.address}...`);
  const result = await request;
  unbanning = false;
  if (result) {
    bansLoaded = result.bans;
    bansError = '';
    setStatus(`Done. ${ban.address} can join again.`);
  }
  renderBans();
  refresh();
  if (!bansList.contains(document.activeElement)) bansList.focus();
}

async function loadBans(): Promise<void> {
  if (bansLoading) return;
  const request = sendApiAction({ action: 'bans' });
  if (!request) return;
  bansLoading = true;
  const result = await request;
  bansLoading = false;
  if (result) {
    bansLoaded = result.bans;
    bansError = '';
  } else if (!bansLoaded) {
    bansError = "Couldn't load the banned addresses.";
  }
  renderBans();
  refresh();
}

function show(): void {
  shown = true;
  updateLive();
  lastRendered = '';
  render();
  if (isLoggedIn()) void loadBans();
}

function hide(): void {
  shown = false;
  confirming = undefined;
  updateLive();
}

export const playersTab: AdminTab = {
  id: 'players',
  label: 'Players',
  panel,
  show,
  hide,
  refresh,
  focusTarget: () =>
    list.querySelector<HTMLElement>('button:not(:disabled)') ?? null,
};
