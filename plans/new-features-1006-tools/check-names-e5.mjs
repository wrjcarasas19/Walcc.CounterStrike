// E.5 (claimed names: the UI). Phases, each its own run, sharing files in
// $OUT (the recovery codes and the browsers' cookies as storage states):
//
//   DATA_VOLUME=cs16-e5 ./run-server.sh de_dust2 2
//   ./pw.sh check-names-e5.mjs setup      # A claims "Walter" in F3
//   ZIP_PORT=27091 ./pw.sh check-names-e5.mjs guest &   # B, no cookie
//   ./pw.sh check-names-e5.mjs owner      # A plays as Walter
//   ./pw.sh check-names-e5.mjs rex        # B claims Rex in game, rejoins
//   ./pw.sh check-names-e5.mjs second     # A's 2nd browser signs in
//   DATA_VOLUME=cs16-e5 ./run-server.sh de_dust2 2      # new container
//   ./pw.sh check-names-e5.mjs after      # still claimed; releases
//
// setup: F3 "Your name" on the login page: claim "Walter" (code shown once,
// Copy code, "I saved it"), the nickname note says "✓ yours"; a stale page
// that thinks it has no name gets device_has_name and offers "Release this
// device"; another browser: a malformed code is refused before sending, a
// wrong one says so. Switches the server to Deathmatch.
// guest (B): joins as Walter, is renamed "Walter (guest)"; in game F3:
// "Claim “Walter”" answers "Someone already claimed that name".
// rex (B's browser again, alone): joins as Rex, claims it in game and uses
// "Rejoin now": the connection drops and comes back as Rex, never renamed.
// owner (A): joins as Walter (not renamed), dies 3 times with `kill`.
// second (A2, a fresh browser): signs in with "walter" + A's code: note
// "✓ yours", nickname set to "Walter"; the leaderboard shows Walter ✓.
// after (new container, same volume): A2 and B still have their names, the
// ✓ is still there; A releases this device; A2 joins and isn't renamed;
// F4 → Players → Claimed names lists Walter and Rex, Release Walter; A2's
// panel and the leaderboard lose the claim; B releases Rex with its code.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  BASE,
  OUT,
  adminAction,
  engineCommand,
  joinGame,
  launch,
  newPage,
  openAdmin,
  pressKey,
  shot,
  waitForPlayer,
} from './lib.mjs';

const role = process.argv[2] ?? 'setup';
const browser = await launch();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(ok, what, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${role}: ${what}${detail ? ` (${detail})` : ''}`);
  if (!ok) failures++;
}

const file = (name) => `${OUT}/e5-${name}`;
const saveState = async (page, name) =>
  writeFileSync(file(`${name}.json`), JSON.stringify(await page.context().storageState()));

async function pageWithState(name, tag) {
  const page = await newPage(browser, { tag });
  if (name) {
    const state = JSON.parse(readFileSync(file(`${name}.json`), 'utf8'));
    await page.context().addCookies(state.cookies);
  }
  return page;
}

async function humans() {
  const status = await (await fetch(`${BASE}/status.json`)).json();
  return status.players.filter((p) => !p.bot).map((p) => p.name);
}

/** What the "Your name" section shows (after the panel is open). */
async function section(page) {
  return page.evaluate(() => {
    const el = document.querySelector('section.names');
    const visible = (sel) => {
      const b = el?.querySelector(sel);
      return !!b && b.offsetParent !== null;
    };
    return {
      shown: !!el && !el.hidden && el.offsetParent !== null,
      intro: el?.querySelector('.names-intro')?.textContent ?? '',
      status: el?.querySelector('.names-status')?.textContent ?? '',
      error: el?.querySelector('.names-status')?.classList.contains('error') ?? false,
      code: visible('.names-code') ? document.getElementById('names-code-value').value : '',
      buttons: [...(el?.querySelectorAll('button') ?? [])]
        .filter((b) => b.offsetParent !== null)
        .map((b) => b.textContent),
    };
  });
}

async function openSettings(page, inGame = false) {
  if (inGame) await pressKey(page, 'F3');
  else await page.click('#settings-launcher-button');
  await page.waitForSelector('section.names:not([hidden])', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(800);
}

async function closeSettings(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

async function clickButton(page, text) {
  await page.locator('section.names button:visible', { hasText: text }).first().click();
  await page.waitForTimeout(1200);
}

async function nicknameNote(page) {
  await page.waitForTimeout(1500);
  return page.evaluate(() => document.getElementById('nickname-status').textContent);
}

async function leaderboardRow(page, name) {
  await page.goto(BASE);
  await page.waitForSelector('#leaderboard:not([hidden])', { timeout: 10_000 }).catch(() => {});
  await page.click('#leaderboard summary').catch(() => {});
  await page.waitForTimeout(1500);
  return page.evaluate((name) => {
    for (const tr of document.querySelectorAll('#leaderboard-rows tr')) {
      const cell = tr.querySelector('.leaderboard-name');
      const text = cell.querySelector('.leaderboard-name-text')?.textContent ?? cell.textContent;
      if (text === name) {
        return {
          mark: cell.querySelector('.leaderboard-claimed')?.textContent ?? '',
          cells: [...tr.children].map((td) => td.textContent),
        };
      }
    }
    return null;
  }, name);
}

async function me(page) {
  return page.evaluate(async () => (await fetch('/names/me')).json());
}

if (role === 'setup') {
  const page = await pageWithState(null, 'A');
  await page.goto(BASE);
  await page.fill('#nickname-input', 'Walter');
  await openSettings(page);
  let s = await section(page);
  check(s.shown, 'section shown on the login page', s.intro);
  check(s.buttons.includes('Claim “Walter”'), 'claim button names the nickname', s.buttons.join(' | '));
  await clickButton(page, 'Claim “Walter”');
  s = await section(page);
  check(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/.test(s.code), 'recovery code shown', s.code);
  check(s.buttons.join('|') === 'Copy code|I saved it', 'only Copy code / I saved it while the code shows', s.buttons.join(' | '));
  writeFileSync(file('walter-code.txt'), s.code);
  await shot(page, 'e5-setup-code');
  await clickButton(page, 'Copy code');
  s = await section(page);
  check(/Copied|by hand/.test(s.status), 'copy answers', s.status);
  // The code stays until confirmed, also across closing the panel.
  await closeSettings(page);
  await openSettings(page);
  s = await section(page);
  check(s.code !== '', 'code still shown after closing and reopening');
  await clickButton(page, 'I saved it');
  s = await section(page);
  check(s.code === '' && /has the name “Walter” ✓/.test(s.intro), 'code gone, browser has Walter', s.intro);
  check(s.buttons.join('|') === 'Release this device|Release the name', 'mine-state buttons', s.buttons.join(' | '));
  await closeSettings(page);
  check((await nicknameNote(page)) === '✓ yours', 'nickname note says ✓ yours');
  await saveState(page, 'A');

  // A stale page that thinks it has no name: the server says
  // device_has_name, the panel switches to the real name.
  const stale = await page.context().newPage();
  await stale.route('**/names/me', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  );
  await stale.goto(BASE);
  await stale.fill('#nickname-input', 'Other');
  await openSettings(stale);
  await clickButton(stale, 'Claim “Other”');
  s = await section(stale);
  check(s.error && /already has the name “Walter”\. Release this device first/.test(s.status), 'device_has_name message', s.status);
  check(s.buttons.includes('Release this device'), 'device_has_name offers Release this device', s.buttons.join(' | '));
  await shot(stale, 'e5-setup-device-has-name');
  await stale.close();

  // Another browser: malformed and wrong codes.
  const other = await pageWithState(null, 'C');
  await other.goto(BASE);
  await openSettings(other);
  await clickButton(other, 'Sign in with a recovery code');
  await other.fill('#names-name', 'Walter');
  await other.fill('#names-code', 'ABC');
  await other.click('section.names button[type=submit]');
  await other.waitForTimeout(800);
  s = await section(other);
  check(s.error && /16 letters and digits/.test(s.status), 'malformed code refused in the page', s.status);
  await other.fill('#names-code', 'AAAA-AAAA-AAAA-AAAA');
  await other.click('section.names button[type=submit]');
  await other.waitForTimeout(1500);
  s = await section(other);
  check(s.error && /Wrong name or recovery code/.test(s.status), 'wrong code message', s.status);
  check(JSON.stringify(await me(other)) === '{}', 'wrong code: not signed in');
  await shot(other, 'e5-setup-wrong-code');

  for (const [name, value] of [
    ['mp_friendlyfire', 0],
    ['mp_freezetime', 0],
    ['wc_gamemode', 2],
  ]) {
    await adminAction({ action: 'cvar', name, value });
  }
  console.log('setup: restart', (await adminAction({ action: 'restart' })).status);
}

if (role === 'guest') {
  const page = await pageWithState(null, 'B');
  await page.goto(BASE);
  await page.fill('#nickname-input', 'Walter');
  check((await nicknameNote(page)) === 'This name is claimed by someone else', 'guest sees the name is claimed');
  await joinGame(page, { name: 'Walter' });
  let renamed = false;
  for (let i = 0; i < 40 && !renamed; i++) {
    renamed = (await humans()).includes('Walter (guest)');
    if (!renamed) await sleep(250);
  }
  check(renamed, 'guest renamed to Walter (guest)', JSON.stringify(await humans()));
  await engineCommand(page, 'jointeam 2');
  await page.waitForTimeout(500);
  await engineCommand(page, 'joinclass 1');
  await page.waitForTimeout(4000);
  await engineCommand(page, 'kill');
  await page.waitForTimeout(4000);

  await openSettings(page, true);
  let s = await section(page);
  check(s.shown, 'section shown in game');
  await clickButton(page, 'Claim “Walter”');
  s = await section(page);
  check(s.error && /Someone already claimed that name/.test(s.status), 'in game: taken', s.status);
  await shot(page, 'e5-guest-taken');
  // Stay while the owner plays (the server keeps renaming nobody else).
  await waitForPlayer('Walter', 400_000).catch(() => {});
  await page.waitForTimeout(40_000);
}

if (role === 'rex') {
  // C joins as Rex (unclaimed), claims it in game, rejoins under it.
  const page = await pageWithState(null, 'B');
  await joinGame(page, { name: 'Rex' });
  await page.waitForTimeout(3000);
  await openSettings(page, true);
  await clickButton(page, 'Claim “Rex”');
  let s = await section(page);
  writeFileSync(file('rex-code.txt'), s.code);
  check(s.code !== '', 'in game: Rex claimed, code shown', s.code);
  await clickButton(page, 'I saved it');
  s = await section(page);
  check(/rejoin/.test(s.status) && s.buttons.includes('Rejoin now'), 'in game: rejoin offered', s.status);
  await shot(page, 'e5-rex-rejoin');
  await clickButton(page, 'Rejoin now');
  await closeSettings(page);
  // The old connection leaves, a new one joins as Rex.
  let left = false;
  for (let i = 0; i < 60 && !left; i++) {
    left = !(await humans()).includes('Rex');
    if (!left) await sleep(250);
  }
  check(left, 'rejoin dropped the old connection');
  let back = false;
  for (let i = 0; i < 120 && !back; i++) {
    back = (await humans()).includes('Rex');
    if (!back) await sleep(500);
  }
  check(back, 'rejoined as Rex', JSON.stringify(await humans()));
  await page.waitForTimeout(8000);
  check((await humans()).includes('Rex'), 'Rex not renamed after rejoining', JSON.stringify(await humans()));
  await saveState(page, 'B');
  await shot(page, 'e5-rex-back');
}

if (role === 'owner') {
  await waitForPlayer('Walter (guest)', 400_000);
  const page = await pageWithState('A', 'A');
  await joinGame(page, { name: 'Walter' });
  await page.waitForTimeout(6000);
  check((await humans()).includes('Walter'), 'owner plays as Walter', JSON.stringify(await humans()));
  await engineCommand(page, 'jointeam 1');
  await page.waitForTimeout(500);
  await engineCommand(page, 'joinclass 1');
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(5000);
    await engineCommand(page, 'kill');
  }
  await page.waitForTimeout(8000);
  check((await humans()).includes('Walter'), 'owner never renamed', JSON.stringify(await humans()));
  const board = await (await fetch(`${BASE}/leaderboard`)).json();
  const walter = board.players.find((p) => p.name === 'Walter');
  console.log('owner: leaderboard', JSON.stringify(board.players.map((p) => [p.name, p.kills, p.deaths, p.claimed])));
  check(walter?.deaths === 3 && walter.claimed === true, 'Walter row: the owner\'s 3 deaths, claimed', JSON.stringify(walter));
}

if (role === 'second') {
  const page = await pageWithState(null, 'A2');
  await page.goto(BASE);
  await page.fill('#nickname-input', '');
  await openSettings(page);
  await clickButton(page, 'Sign in with a recovery code');
  await page.fill('#names-name', 'walter');
  await page.fill('#names-code', readFileSync(file('walter-code.txt'), 'utf8').toLowerCase().replaceAll('-', ' '));
  await page.click('section.names button[type=submit]');
  await page.waitForTimeout(1500);
  const s = await section(page);
  check(/Signed in: this browser has “Walter”/.test(s.status) && /has the name “Walter” ✓/.test(s.intro), 'A2 signed in with the code (any case, spaces)', s.status);
  await closeSettings(page);
  check((await page.inputValue('#nickname-input')) === 'Walter', 'nickname set to the claimed spelling');
  check((await nicknameNote(page)) === '✓ yours', 'A2 note ✓ yours');
  await shot(page, 'e5-second-signed-in');
  await saveState(page, 'A2');
  const row = await leaderboardRow(page, 'Walter');
  check(row?.mark === '✓', 'leaderboard shows Walter ✓', JSON.stringify(row));
  const guest = await leaderboardRow(page, 'Walter (guest)');
  check(guest === null || guest.mark === '', 'no ✓ on Walter (guest)', JSON.stringify(guest));
  await page.evaluate(() => document.getElementById('leaderboard').scrollIntoView());
  await shot(page, 'e5-second-leaderboard');
}

if (role === 'after') {
  // After a new container on the same DATA_DIR volume.
  const a2 = await pageWithState('A2', 'A2');
  await a2.goto(BASE);
  check(JSON.stringify(await me(a2)) === '{"name":"Walter"}', 'A2 still has Walter after the restart');
  const b = await pageWithState('B', 'B');
  await b.goto(BASE);
  check(JSON.stringify(await me(b)) === '{"name":"Rex"}', 'B still has Rex after the restart');
  const row = await leaderboardRow(a2, 'Walter');
  check(row?.mark === '✓' && row.cells[3] === '3', 'leaderboard row and ✓ kept', JSON.stringify(row));

  // A releases this device (the claim stays).
  const a = await pageWithState('A', 'A');
  await a.goto(BASE);
  await openSettings(a);
  await clickButton(a, 'Release this device');
  let s = await section(a);
  check(s.buttons.join('|') === 'Release this device|Cancel', 'release device asks first', s.buttons.join(' | '));
  await a.click('section.names button[type=submit]');
  await a.waitForTimeout(1500);
  s = await section(a);
  check(/no longer has “Walter”/.test(s.status) && /^Claim your nickname so/.test(s.intro), 'A released this device', s.status);
  check(JSON.stringify(await me(a)) === '{}', 'A has no name now');
  check(JSON.stringify(await me(a2)) === '{"name":"Walter"}', 'A2 still has Walter');
  await a.close();

  // A2 joins (not renamed) and releases Walter from F4.
  await joinGame(a2, { name: 'Walter' });
  await a2.waitForTimeout(6000);
  check((await humans()).includes('Walter'), 'A2 plays as Walter after the restart', JSON.stringify(await humans()));
  await openAdmin(a2);
  await a2.click('#admin-tab-players');
  await a2.waitForTimeout(2000);
  const claims = () =>
    a2.evaluate(() =>
      [...document.querySelectorAll('.admin-claim')].map((el) => el.textContent)
    );
  let list = await claims();
  check(list.length === 2 && /Walter1 browser/.test(list[0]) && /Rex/.test(list[1]), 'admin lists Walter and Rex', JSON.stringify(list));
  await shot(a2, 'e5-admin-claims');
  await a2.click('.admin-claim-release[aria-label="Release the name Walter"]');
  await a2.waitForTimeout(500);
  await a2.click('.admin-claim-confirm');
  await a2.waitForTimeout(2000);
  list = await claims();
  check(list.length === 1 && /Rex/.test(list[0]), 'Walter released by the admin', JSON.stringify(list));
  await shot(a2, 'e5-admin-released');
  await a2.keyboard.press('Escape');
  check(JSON.stringify(await me(a2)) === '{}', 'A2 lost the name');
  await openSettings(a2, true);
  s = await section(a2);
  check(/Claim your nickname/.test(s.intro) || s.buttons.some((t) => t.startsWith('Claim')), 'A2 panel shows no name', s.intro);
  await closeSettings(a2);
  await sleep(6000);
  const board = await (await fetch(`${BASE}/leaderboard`)).json();
  const walter = board.players.find((p) => p.name === 'Walter');
  check(walter?.claimed === false && walter.deaths === 3, 'leaderboard row kept without the claim', JSON.stringify(walter));

  // B releases Rex with its code.
  await openSettings(b);
  await clickButton(b, 'Release the name');
  await b.fill('#names-code', readFileSync(file('rex-code.txt'), 'utf8'));
  await b.click('section.names button[type=submit]');
  await b.waitForTimeout(1500);
  s = await section(b);
  check(/Released “Rex”/.test(s.status), 'B released Rex with the code', s.status);
  check(JSON.stringify(await me(b)) === '{}', 'B has no name now');
  const left = await adminAction({ action: 'claims' });
  check(left.status === 200 && !left.body.includes('"claims"'), 'no claims left', left.body);
}

if (role === 'engine') {
  // The page's 31-byte cut matches what the engine keeps: a name with ".."
  // and two-byte letters arrives in status.json exactly as the page cut it.
  const page = await pageWithState(null, 'E');
  const typed = 'Wal..ter ' + 'é'.repeat(20);
  const expected = 'Wal.ter ' + 'é'.repeat(11); // 8 + 22 = 30 bytes
  await joinGame(page, { name: typed });
  // status.json lists a player once they entered the game.
  let names = [];
  for (let i = 0; i < 30 && !names.includes(expected); i++) {
    await page.waitForTimeout(2000);
    names = await humans();
  }
  check(names.includes(expected), 'engine keeps the page\'s cut', JSON.stringify(names));
  check(Buffer.byteLength(expected) === 30, 'expected name is 30 bytes');
}

await browser.close();
console.log(`${role}: ${failures === 0 ? 'all ok' : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
