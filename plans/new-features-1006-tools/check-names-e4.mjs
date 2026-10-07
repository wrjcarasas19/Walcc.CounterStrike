// E.4 (claimed names: enforcing the claim). Two browsers, one page each,
// run at once against a fresh server (empty claims table) with a few bots:
//   ZIP_PORT=27091 ./pw.sh check-names-e4.mjs guest &   # no cookie
//   ./pw.sh check-names-e4.mjs owner
// The owner claims "Walter" (cookie), switches the server to Deathmatch and
// checks the login page note ("✓ yours"). The guest sees "This name is
// claimed by someone else", joins as "Walter" anyway and must be renamed to
// "Walter (guest)" and get the server's chat line; then the owner joins as
// "Walter" and isn't renamed. Both die a few times with `kill` (and to the
// bots). Then the guest takes the name back with `name WALTER` (the
// client's own name cvar still says "Walter": amx_nick only changes the
// server's copy, so `name Walter` would send nothing) and dies at once
// under it: renamed again, another chat line, and that death mustn't count
// anywhere.
// Afterwards compare the server's log (docker exec ... cstrike/logs) with
// /leaderboard: the "Walter" row has exactly the owner's deaths.
import { BASE, launch, newPage, joinGame, waitForPlayer, adminAction, engineCommand, shot } from './lib.mjs';

const role = process.argv[2] ?? 'owner';
const browser = await launch();
const page = await newPage(browser, { tag: role });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function status() {
  return (await fetch(`${BASE}/status.json`)).json();
}

async function humans() {
  return (await status()).players.filter((p) => !p.bot).map((p) => p.name);
}

/** Types a name in the login form and returns the note under it. */
async function loginNote(name) {
  await page.goto(BASE);
  await page.fill('#nickname-input', name);
  await page.waitForFunction(() => document.getElementById('nickname-status').textContent, null, { timeout: 8000 }).catch(() => {});
  return page.evaluate(() => {
    const note = document.getElementById('nickname-status');
    return { text: note.textContent, kind: note.dataset.kind ?? '' };
  });
}

async function chatNow() {
  return page.evaluate(() => document.getElementById('hud-chat')?.textContent ?? '');
}

/** The chat feed's text once it has the server's line (or after 10 s). */
async function chatText() {
  let chat = '';
  for (let i = 0; i < 20 && !chat.includes('That name is claimed'); i++) {
    chat = await page.evaluate(() => document.getElementById('hud-chat')?.textContent ?? '');
    await sleep(500);
  }
  return chat;
}

async function joinTeam() {
  await engineCommand(page, 'jointeam 2');
  await page.waitForTimeout(500);
  await engineCommand(page, 'joinclass 1');
}

async function play(times) {
  for (let i = 0; i < times; i++) {
    await page.waitForTimeout(5000);
    await engineCommand(page, 'kill');
  }
}

if (role === 'guest') {
  // Wait for the owner's claim.
  for (;;) {
    const s = await (await fetch(`${BASE}/names/status?name=Walter`)).json().catch(() => ({}));
    if (s.claimed) break;
    await sleep(1000);
  }
  const note = await loginNote('Walter');
  console.log('guest: login note', JSON.stringify(note));
  await shot(page, 'e4-guest-login');
  await joinGame(page, { name: 'Walter' });
  const joined = Date.now();
  let renamedAfter = -1;
  while (Date.now() - joined < 15_000) {
    const names = await humans();
    if (names.includes('Walter (guest)')) {
      renamedAfter = Date.now() - joined;
      break;
    }
    await sleep(250);
  }
  console.log('guest: in game as', JSON.stringify(await humans()), 'renamed', renamedAfter, 'ms after the HUD showed');
  // The chat line waits until the player is in a team (renamed on the
  // loading screen, where the page would wipe it).
  await page.waitForTimeout(8000);
  console.log('guest: chat before a team', JSON.stringify(await chatNow()));
  await joinTeam();
  console.log('guest: chat after joining a team', JSON.stringify(await chatText()));
  await shot(page, 'e4-guest-renamed');
  await play(3);
  // Wait until the owner is in and has died a few times, then take the
  // name back and die at once under it.
  await waitForPlayer('Walter', 240_000);
  await page.waitForTimeout(25_000);
  console.log('guest: name WALTER + kill');
  await engineCommand(page, 'name WALTER');
  await page.waitForTimeout(300);
  await engineCommand(page, 'kill');
  const t = Date.now();
  let names = [];
  while (Date.now() - t < 15_000) {
    names = await humans();
    if (names.some((n) => n.startsWith('WALTER') && n.endsWith('(guest)')) || names.some((n) => /^Player \d+$/.test(n))) break;
    await sleep(250);
  }
  console.log('guest: after taking the name back', JSON.stringify(names), Date.now() - t, 'ms');
  console.log('guest: chat', JSON.stringify(await chatText()));
  await shot(page, 'e4-guest-renamed-again');
  await page.waitForTimeout(20_000);
  await browser.close();
  process.exit(0);
}

await page.goto(BASE);
const claim = await page.evaluate(async () => {
  const res = await fetch('/names/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Walter' }),
  });
  return { status: res.status, body: await res.json() };
});
console.log('owner: claim', claim.status, claim.body.name ?? claim.body.error);
for (const [name, value] of [
  ['mp_friendlyfire', 0],
  ['mp_freezetime', 0],
  ['wc_gamemode', 2],
]) {
  console.log('owner: cvar', name, (await adminAction({ action: 'cvar', name, value })).status);
}
console.log('owner: restart', (await adminAction({ action: 'restart' })).status);
const note = await loginNote('walter ');
console.log('owner: login note', JSON.stringify(note));
await shot(page, 'e4-owner-login');

await waitForPlayer('Walter (guest)', 300_000);
console.log('owner: the guest is in as Walter (guest); joining as Walter');
await joinGame(page, { name: 'Walter' });
await page.waitForTimeout(6000);
console.log('owner: in game as', JSON.stringify(await humans()));
await joinTeam();
await play(4);
await page.waitForTimeout(40_000);
console.log('owner: still', JSON.stringify(await humans()));
const board = await (await fetch(`${BASE}/leaderboard`)).json();
console.log('owner: leaderboard', JSON.stringify(board.players.map((p) => [p.name, p.kills, p.deaths])));
await browser.close();
