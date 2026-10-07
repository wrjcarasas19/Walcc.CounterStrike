// Smoke check of the tool itself: WebGL renderer, the login page, then join
// the game and wait for the player on the server.
import { BASE, launch, newPage, shot, webglInfo, joinGame, waitForPlayer } from './lib.mjs';
const browser = await launch();
const page = await newPage(browser, { tag: 'probe' });
await page.goto(BASE);
console.log('webgl:', await webglInfo(page));
await page.waitForTimeout(3000);
console.log('lobby:', (await page.textContent('#lobby'))?.replace(/\s+/g, ' ').trim());
await shot(page, 'probe-login');
await joinGame(page, { name: 'Headless' });
await waitForPlayer('Headless');
console.log('joined; packets', await page.evaluate(() => JSON.stringify(window.__dc)));
await page.waitForTimeout(3000);
await shot(page, 'probe-ingame');
await browser.close();
