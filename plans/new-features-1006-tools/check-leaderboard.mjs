// A.5: the login page's "Top players" table has the Gun Game wins column
// and shows /leaderboard's ggWins, on a desktop and a phone-sized page.
// Needs a server whose leaderboard has a Gun Game win (see README.md).
import { BASE, launch, newPage, shot } from './lib.mjs';

const expected = await (await fetch(`${BASE}/leaderboard`)).json();
const winners = expected.players.filter((p) => p.ggWins > 0);
console.log('leaderboard winners:', winners.map((p) => `${p.name}=${p.ggWins}`).join(', ') || 'none');

const browser = await launch();
let failed = false;
for (const [tag, width, height] of [
  ['desktop', 1280, 800],
  ['phone', 390, 844],
]) {
  const page = await newPage(browser, { tag, width, height });
  await page.goto(BASE);
  await page.waitForSelector('#leaderboard:not([hidden])', { timeout: 15_000 });
  await page.click('#leaderboard summary');
  await page.waitForSelector('#leaderboard-table:not([hidden])');
  const table = await page.evaluate(() => {
    const head = [...document.querySelectorAll('#leaderboard-table th')].map((th) => [
      th.textContent.trim(),
      th.title,
    ]);
    const rows = [...document.querySelectorAll('#leaderboard-rows tr')].map((tr) =>
      [...tr.cells].map((td) => td.textContent)
    );
    const scroll = document.documentElement.scrollWidth > document.documentElement.clientWidth;
    return { head, rows, scroll };
  });
  console.log(`[${tag}] head:`, JSON.stringify(table.head));
  for (const row of table.rows) console.log(`[${tag}] row:`, JSON.stringify(row));
  const gg = table.head.findIndex(([text]) => text === 'GG');
  if (gg < 0 || table.head[gg][1] !== 'Gun Game wins') {
    console.log(`[${tag}] FAIL: no GG column`);
    failed = true;
  }
  for (const p of expected.players) {
    const row = table.rows.find((r) => r[1] === p.name);
    if (!row || row[gg] !== String(p.ggWins)) {
      console.log(`[${tag}] FAIL: ${p.name} shows ${row?.[gg]}, want ${p.ggWins}`);
      failed = true;
    }
  }
  if (table.scroll) {
    console.log(`[${tag}] FAIL: the page scrolls sideways`);
    failed = true;
  }
  await shot(page, `leaderboard-${tag}`);
  await page.close();
}
await browser.close();
console.log(failed ? 'FAILED' : 'OK');
process.exit(failed ? 1 : 0);
