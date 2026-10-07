// Layout-only check of the "Killed by" card (D.4), without the game: loads
// the built page (any static server for dist/, BASE), shows the HUD with
// the card filled the way killcard.ts fills it, plus the clock, Gun Game
// strip, money and chat, and checks at desktop, phone landscape (touch)
// and portrait sizes that the card stays in the viewport, below the
// crosshair and clear of the clock / strip. Screenshots in $OUT.
//   python3 -m http.server 27099 -d dist &   # from the repo root
//   BASE=http://127.0.0.1:27099 ./pw.sh check-killcard-layout-d4.mjs
// Also while spectating (#hud data-spectating): the card stays above the
// engine's bottom spectator bar (the lowest 20 %, with the "<name> (health)"
// label at 90 %).
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:27099';
const OUT = process.env.OUT ?? 'out';

const SIZES = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'desktop-small', width: 1024, height: 576 },
  { name: 'phone-landscape', width: 844, height: 390, mobile: true },
  { name: 'phone-portrait', width: 390, height: 844, mobile: true },
];

const FULL = `
<div class="hud-kc-head"><span class="hud-kc-title">Killed by</span> <span class="hud-kc-killer t">Walter the Magnificent</span></div>
<div class="hud-kc-weapon"><svg class="hud-icon hud-kc-icon" viewBox="0 0 24 24"><path d="M2 8h15V6h3v2h2v3h-5l-1 2h-3l-1 3H8l1-5H2z"/></svg><span class="hud-kc-weapon-name">AK-47</span><span class="hud-kc-tag hs">Headshot</span><span class="hud-kc-tag">Through a wall</span></div>
<div class="hud-kc-details">87 HP · 100 armour · 23 m</div>
<div class="hud-kc-duel">This map: you 2 – 5 Walter the Magnificent</div>
<div class="hud-kc-duel">All time: 14 – 22</div>
<div class="hud-kc-streak">Walter the Magnificent is on a 6 kill streak</div>`;

let failures = 0;
function check(ok, message) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures++;
}

const browser = await chromium.launch({ headless: true });
for (const size of SIZES) {
  for (const [gunGame, spectating] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      isMobile: !!size.mobile,
      hasTouch: !!size.mobile,
    });
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const box = await page.evaluate(
      ({ html, gunGame, spectating }) => {
        const desk = document.getElementById('desktop');
        if (desk) desk.style.display = 'none';
        const hud = document.getElementById('hud');
        hud.hidden = false;
        hud.dataset.alive = 'false';
        hud.classList.toggle('gun-game', gunGame);
        hud.dataset.spectating = String(spectating);
        const show = (id, text) => {
          const el = document.getElementById(id);
          el.hidden = false;
          if (text !== undefined) el.textContent = text;
        };
        show('hud-timer');
        document.getElementById('hud-timer-value').textContent = '1:23';
        show('hud-money');
        document.getElementById('hud-money-value').textContent = '16,000';
        if (gunGame) {
          show('hud-gg');
          document.getElementById('hud-gg-level').textContent = 'Level 12/24';
          document.getElementById('hud-gg-weapon').textContent = 'AK-47';
        }
        const card = document.getElementById('hud-killcard');
        card.className = 'hud-killcard enemy';
        card.innerHTML = html;
        card.hidden = false;
        const rect = (el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
        };
        return {
          card: rect(card),
          timer: rect(document.getElementById('hud-timer')),
          gg: gunGame ? rect(document.getElementById('hud-gg')) : undefined,
          lines: [...card.children].map((c) => {
            const r = c.getBoundingClientRect();
            const cr = card.getBoundingClientRect();
            return r.bottom <= cr.bottom + 0.5;
          }),
          scrollWidth: document.documentElement.scrollWidth,
          pointer: getComputedStyle(card).pointerEvents,
        };
      },
      { html: FULL, gunGame, spectating }
    );
    // Wait for the entry animation before the screenshot.
    await page.waitForTimeout(400);
    const tag = `${size.name}${gunGame ? '-gg' : ''}${spectating ? '-spec' : ''}`;
    await page.screenshot({ path: `${OUT}/killcard-${tag}.png` });
    const { card, timer, gg } = box;
    const centre = size.height / 2;
    check(card.top > centre + 10, `${tag}: card top ${card.top | 0} below crosshair ${centre}`);
    check(card.left >= 0 && card.right <= size.width, `${tag}: card inside the viewport (${card.left | 0}..${card.right | 0})`);
    check(card.bottom <= timer.top + 1 || card.top >= timer.bottom - 1, `${tag}: clear of the clock (card bottom ${card.bottom | 0}, clock ${timer.top | 0}..${timer.bottom | 0})`);
    if (gg) check(card.bottom <= gg.top + 1, `${tag}: clear of the Gun Game strip`);
    if (spectating) {
      // Measured after the entry animation (it starts 0.6em lower).
      const bottom = await page.evaluate(
        () => document.getElementById('hud-killcard').getBoundingClientRect().bottom
      );
      check(bottom <= size.height * 0.8, `${tag}: above the spectator bar (card bottom ${bottom | 0}, bar ${size.height * 0.8 | 0})`);
    }
    check(box.scrollWidth <= size.width, `${tag}: no sideways scroll`);
    check(box.pointer === 'none', `${tag}: takes no input`);
    console.log(`     ${tag}: lines fully shown ${box.lines.filter(Boolean).length}/${box.lines.length}`);
    await context.close();
  }
}
await browser.close();
console.log(failures ? `${failures} failed` : 'all ok');
process.exitCode = failures ? 1 : 0;
