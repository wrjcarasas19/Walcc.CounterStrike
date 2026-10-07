// Game modes on the page (A.1-A.3, gap fixes): lobby line, F4 Match tab,
// F3 settings, the Gun Game HUD message of an old client (cs16-client
// 0.0.9: no wc_html_hud), and a Match tab preset restarting the round.
// Needs the server from run-server.sh. Leaves the server in Deathmatch.
import {
  BASE, launch, newPage, shot, joinGame, waitForPlayer, engineCommand,
  openAdmin, pressKey, adminAction,
} from './lib.mjs';

const results = [];
const check = (ok, what) => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  console.log(results.at(-1));
};
const text = async (page, selector) =>
  ((await page.textContent(selector)) ?? '').replace(/\s+/g, ' ').trim();

// Gun Game on, and a fun map next (for the Match tab's note).
console.log(await adminAction({ action: 'cvar', name: 'wc_gamemode', value: 1 }));
console.log(await adminAction({ action: 'restart' }));
console.log(await adminAction({ action: 'set_nextmap', map: 'fy_iceworld' }));
await new Promise((r) => setTimeout(r, 4000));
const status = await (await fetch(`${BASE}/status.json`)).json();
check(status.gameMode === 1, `status.json gameMode ${status.gameMode}`);

const browser = await launch();
const page = await newPage(browser, { tag: 'gm' });
await page.goto(BASE);
await page.waitForTimeout(3000);
const lobby = await text(page, '#lobby');
check(/Gun Game/.test(lobby), `lobby line: ${lobby.slice(0, 80)}`);
await shot(page, 'gm-1-lobby');

await joinGame(page, { name: 'Headless' });
await waitForPlayer('Headless');
await page.waitForTimeout(2000);
await engineCommand(page, 'jointeam 2');
await page.waitForTimeout(1000);
await engineCommand(page, 'joinclass 5');
await page.waitForTimeout(6000);
await shot(page, 'gm-2-gungame-hud');

await openAdmin(page);
await page.click('#admin-tab-match');
await page.waitForTimeout(2500);
const match = await text(page, '#admin-panel-match');
check(/Game mode/.test(match), 'Match tab has a Game mode field');
check(/Gun Game/.test(match) && /Deathmatch/.test(match), 'GG and DM presets');
check(/Gun Game is on\. Knife only and pistols only don't work/.test(match), 'weapon mode note while Gun Game is on');
check(/The next map, fy_iceworld, has its own settings/.test(match), 'fun map note names fy_iceworld');
await shot(page, 'gm-3-match-tab');
await page.click('#admin-panel-match button:has-text("Knife only")');
await page.waitForTimeout(800);
const refused = await text(page, '#admin-menu');
check(/Not sent: Knife only doesn't work during Gun Game/.test(refused), 'Knife only refused during Gun Game');
await shot(page, 'gm-4-knife-refused');

// A preset that changes wc_gamemode: one round restart (gap fix 1).
const before = Date.now();
await page.click('#admin-panel-match button:has-text("Deathmatch")');
await page.waitForTimeout(8000);
const after = await text(page, '#admin-menu');
check(/Deathmatch applied and the round restarted/.test(after), 'Deathmatch preset confirmed');
await shot(page, 'gm-5-deathmatch-preset');
console.log(`preset clicked at ${new Date(before).toISOString()}`);

await pressKey(page, 'Escape');
await pressKey(page, 'F3');
await page.waitForTimeout(500);
await shot(page, 'gm-6-settings');
const settings = await page.evaluate(() =>
  [...document.querySelectorAll('.settings-field')].filter((e) => e.offsetParent).length
);
check(settings > 0, `F3 settings shows ${settings} fields`);
await pressKey(page, 'F3');
await page.waitForTimeout(3000);
await shot(page, 'gm-7-deathmatch');

await browser.close();
console.log(results.join('\n'));
if (results.some((r) => r.startsWith('FAIL'))) process.exitCode = 1;
