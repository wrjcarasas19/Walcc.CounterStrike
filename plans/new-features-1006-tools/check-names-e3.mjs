// E.3 (claimed names: knowing who is playing). Two browsers, one page each
// (two games in one headless browser stall in signon), run at once:
//   ZIP_PORT=27091 ./pw.sh check-names-e3.mjs guest &   # no cookie
//   ./pw.sh check-names-e3.mjs owner
// The owner claims "Walter" on the login page (POST /names/claim sets the
// wc_player cookie), joins, waits for the guest, has the map changed and
// stays a little. It prints the sha256 of its device token: the server's
// stderr must then show
//   leaderboard: #<userid> "Walter" connected with device <first 8 hex>
// once after the join and once more (new userid) after the map change,
// and nothing for the guest. Needs a server with E.3 and an empty claims
// table ("Walter" not claimed yet).
import { createHash } from 'node:crypto';
import { BASE, launch, newPage, joinGame, waitForPlayer, adminAction } from './lib.mjs';

const role = process.argv[2] ?? 'owner';
const browser = await launch();
const page = await newPage(browser, { tag: role });

if (role === 'guest') {
  await joinGame(page, { name: 'Guest' });
  await waitForPlayer('Guest');
  console.log('guest: joined as Guest (no cookie)');
  await page.waitForTimeout(120_000);
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
const cookie = (await page.context().cookies()).find((c) => c.name === 'wc_player');
if (!cookie) throw new Error('no wc_player cookie after the claim');
const hash = createHash('sha256').update(Buffer.from(cookie.value, 'base64url')).digest('hex');
console.log('owner: device token hash', hash, '-> expect', hash.slice(0, 8));

await joinGame(page, { name: 'Walter' });
await waitForPlayer('Walter');
console.log('owner: joined as Walter');
await waitForPlayer('Guest', 240_000);
console.log('owner: guest is in');
await page.waitForTimeout(4000);

console.log('owner: changelevel', (await adminAction({ action: 'changelevel', map: 'de_dust2' })).status);
await page.waitForTimeout(20_000);
await waitForPlayer('Walter');
await waitForPlayer('Guest');
console.log('owner: both back after the map change');
await page.waitForTimeout(4000);
await browser.close();
