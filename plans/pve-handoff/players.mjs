// Headless test players for the local server (http://127.0.0.1:27016).
// Usage: node players.mjs Name1 Name2 ...   (runs until killed)
// Control: append lines to cmd.txt next to this file:
//   shot <i> <file.png>    screenshot of player i
//   eval <i> <js>          evaluate js in player i's page, print the result
//   open <name>            add a player
//   close <i>              close player i
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname);
const cmdFile = path.join(dir, 'cmd.txt');
fs.writeFileSync(cmdFile, '');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const context = await chromium.launchPersistentContext(path.join(dir, process.env.PROFILE || 'profile-fresh'), {
  // CHROME=/path/to/chrome overrides Playwright's bundled Chromium (npx playwright install chromium).
  executablePath: process.env.CHROME || undefined,
  headless: true,
  viewport: { width: 1280, height: 720 },
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
});
const pages = [];
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await context.close().catch(() => {});
    process.exit(0);
  });
}

async function join(name) {
  const page = await context.newPage();
  const i = pages.push(page) - 1;
  page.on('console', (m) => {
    if (m.type() === 'error') log(`[${i}] console:`, m.text().slice(0, 200));
  });
  await page.goto('http://127.0.0.1:27016/');
  await page.fill('#nickname-input', name);
  // Start: download / load files; then Connect.
  for (let n = 0; n < 600; n++) {
    const label = (await page.textContent('#action-button'))?.trim();
    if (label === 'Connect') break;
    if (!(await page.isDisabled('#action-button'))) await page.click('#action-button');
    await page.waitForTimeout(2000);
  }
  await page.click('#action-button');
  log(`[${i}] ${name}: connecting`);
  // Team menu (HTML), then the character menu.
  await page.waitForSelector('#team-menu .team-option', { timeout: 180000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(dir, `team-${i}.png`) });
  // Co-op skips the team menu (humans_join_team CT): click through what shows.
  for (let n = 0; n < 5; n++) {
    const options = page.locator('#team-menu .team-option:visible');
    if ((await options.count()) === 0) break;
    const title = await page.textContent('#team-title');
    if (title === 'Choose a team') {
      await page.click('#team-menu .team-option[data-side="CT"]:not(:disabled):visible');
    } else {
      await options.first().click();
    }
    await page.waitForTimeout(1500);
  }
  log(`[${i}] ${name}: joined CT`);
  return i;
}

for (const name of process.argv.slice(2)) {
  await join(name).catch((e) => log('join failed', name, e.message.slice(0, 200)));
}

setInterval(async () => {
  const text = fs.readFileSync(cmdFile, 'utf8');
  if (!text) return;
  fs.writeFileSync(cmdFile, '');
  for (const line of text.split('\n').filter(Boolean)) {
    const [cmd, a, ...rest] = line.split(' ');
    try {
      if (cmd === 'shot') {
        await pages[+a].screenshot({ path: path.join(dir, rest[0]) });
        log('shot', rest[0]);
      } else if (cmd === 'eval') {
        log('eval', JSON.stringify(await pages[+a].evaluate(rest.join(' '))));
      } else if (cmd === 'type') {
        // type <i> <text>: the text, then Enter (console: backquote first).
        const page = pages[+a];
        await page.keyboard.press('Backquote');
        await page.waitForTimeout(500);
        await page.keyboard.type(rest.join(' '));
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        await page.keyboard.press('Backquote');
        log('typed', rest.join(' '));
      } else if (cmd === 'open') {
        await join(a).catch((e) => log('join failed', a, e.message.slice(0, 200)));
      } else if (cmd === 'close') {
        await pages[+a].close();
        log('closed', a);
      }
    } catch (e) {
      log('error', cmd, e.message.slice(0, 300));
    }
  }
}, 1000);
