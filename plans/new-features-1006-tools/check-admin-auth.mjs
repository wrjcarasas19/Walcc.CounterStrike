// F4 admin menu: the "Admin password" field and Log in button are hidden
// after logging in and shown again after logging out (`#admin-auth` has
// class `field`, display: flex, so it needs `.field[hidden]`). Any server:
// ./run-server.sh de_dust2 2 && ./pw.sh check-admin-auth.mjs
import {
  ADMIN_PASSWORD,
  launch,
  newPage,
  shot,
  joinGame,
  waitForPlayer,
  pressKey,
} from './lib.mjs';
const browser = await launch();
const page = await newPage(browser, { tag: 'auth' });
await joinGame(page, { name: 'AuthCheck' });
await waitForPlayer('AuthCheck', 300_000);
let fails = 0;
const state = () =>
  page.evaluate(() => {
    const vis = (id) => {
      const el = document.getElementById(id);
      const r = el.getBoundingClientRect();
      return (
        !el.hidden && getComputedStyle(el).display !== 'none' && r.height > 0
      );
    };
    return {
      auth: vis('admin-auth'),
      password: vis('admin-password'),
      login: vis('admin-login'),
      session: vis('admin-session'),
    };
  });
const expect = (s, want, what) => {
  const ok = Object.entries(want).every(([k, v]) => s[k] === v);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what} ${JSON.stringify(s)}`);
  if (!ok) fails++;
};
await pressKey(page, 'F4');
expect(
  await state(),
  { auth: true, password: true, login: true, session: false },
  'logged out: field and Log in shown',
);
await shot(page, 'auth-logged-out');
await page.fill('#admin-password', ADMIN_PASSWORD);
await page.click('#admin-login');
await page.waitForTimeout(1500);
expect(
  await state(),
  { auth: false, password: false, login: false, session: true },
  'logged in: field and Log in hidden',
);
await shot(page, 'auth-logged-in');
await page.click('#admin-logout');
await page.waitForTimeout(1500);
expect(
  await state(),
  { auth: true, password: true, login: true, session: false },
  'logged out again: field shown',
);
await shot(page, 'auth-logged-out-again');
await browser.close();
console.log(fails ? `${fails} failed` : 'all ok');
process.exitCode = fails ? 1 : 0;
