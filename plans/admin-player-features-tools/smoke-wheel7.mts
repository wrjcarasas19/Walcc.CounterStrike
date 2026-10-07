import assert from 'node:assert/strict';
import {
  PAGES, itemCommand, checkChatLine, sectorAt, sectorAngle, itemIndexForKey,
  stepPage, clampVector, wheelKeyMatches, PAGE_ITEMS_MAX,
} from '../../src/client/src/wheel/items.ts';
import { checkSetting, defaultSettings, parseSettings } from '../../src/client/src/settings/schema.ts';

// Every item's command is a radio command or a quoted say_team line.
const radio = new Set(['coverme','takepoint','holdpos','regroup','followme','takingfire','go','fallback','sticktog','getinpos','stormfront','report','roger','enemyspot','needbackup','sectorclear','inposition','reportingin','getout','negative','enemydown']);
const seen = new Set<string>();
for (const page of PAGES) {
  assert.ok(page.items.length >= 2 && page.items.length <= PAGE_ITEMS_MAX);
  for (const item of page.items) {
    const c = itemCommand(item);
    if (c.startsWith('say_team ')) assert.match(c, /^say_team "[A-Za-z0-9!?. ]+"$/);
    else assert.ok(radio.has(c), c);
    seen.add(c);
  }
}
for (const r of radio) assert.ok(seen.has(r), `missing ${r}`);
console.log(PAGES.map((p) => `${p.label}: ${p.items.map((i) => i.command).join(', ')}`).join('\n'));

// Unsafe commands and chat lines are refused.
for (const bad of ['quit', 'say_team "a";quit', 'say_team "100%"', 'say_team "a\\b"', 'say_team "@admins"', 'say_team "a"b"', 'say_team "//x"', 'coverme;quit', 'say_team ""', 'say "hi"', 'Coverme', 'coverme ']) {
  assert.throws(() => itemCommand({ label: 'x', command: bad }), bad);
}
for (const line of ['Nice shot!', 'Rush B', 'Drop me a weapon please', 'a?b.c!']) assert.ok(checkChatLine(line), line);
for (const line of ['', ' x', 'x ', 'a  b', '100%', 'it\'s', 'a,b', '@all', 'a/b', 'a;b', 'a"b', 'a\\b', 'é', 'a\tb', 'x'.repeat(49)]) assert.ok(!checkChatLine(line), line);

// Directions: item 0 at the top, clockwise.
assert.equal(sectorAt(0, -100, 6, 24), 0);
assert.equal(sectorAt(100, 0, 4, 24), 1);
assert.equal(sectorAt(0, 100, 4, 24), 2);
assert.equal(sectorAt(-100, 0, 4, 24), 3);
assert.equal(sectorAt(-1, -100, 4, 24), 0); // just left of the top
assert.equal(sectorAt(10, 10, 4, 24), -1); // dead zone
assert.equal(sectorAt(NaN, 5, 4, 0), -1);
assert.equal(sectorAt(0, -100, 0, 0), -1);
for (const n of [2, 3, 6, 8, 9]) {
  for (let i = 0; i < n; i++) {
    const a = (sectorAngle(i, n) * Math.PI) / 180;
    assert.equal(sectorAt(Math.sin(a) * 50, -Math.cos(a) * 50, n, 24), i, `centre ${i}/${n}`);
    // Just inside both edges of the sector.
    for (const off of [-0.49, 0.49]) {
      const b = a + (off * 2 * Math.PI) / n;
      assert.equal(sectorAt(Math.sin(b) * 50, -Math.cos(b) * 50, n, 24), i, `edge ${i}/${n} ${off}`);
    }
  }
}

assert.equal(itemIndexForKey('Digit1'), 0);
assert.equal(itemIndexForKey('Numpad9'), 8);
assert.equal(itemIndexForKey('Digit0'), -1);
assert.equal(itemIndexForKey('KeyZ'), -1);
assert.equal(stepPage(0, -1, 4), 3);
assert.equal(stepPage(3, 1, 4), 0);
assert.deepEqual(clampVector(300, 400, 50), { x: 30, y: 40 });
assert.deepEqual(clampVector(3, 4, 50), { x: 3, y: 4 });

const ev = (key: string, mods: Partial<KeyboardEvent> = {}) => ({ key, altKey: false, metaKey: false, ...mods });
assert.ok(wheelKeyMatches('z', ev('z')));
assert.ok(wheelKeyMatches('z', ev('Z')));
assert.ok(!wheelKeyMatches('z', ev('z', { altKey: true })));
assert.ok(!wheelKeyMatches('z', ev('v')));
assert.ok(wheelKeyMatches('v', ev('v')));
assert.ok(!wheelKeyMatches('off', ev('z')));

// Setting.
assert.equal(defaultSettings().radioWheelKey, 'z');
assert.equal(checkSetting('radioWheelKey', 'v'), 'v');
assert.equal(checkSetting('radioWheelKey', 'x'), undefined);
assert.equal(parseSettings('{"radioWheelKey":"off"}').radioWheelKey, 'off');
assert.equal(parseSettings('{"radioWheelKey":"KeyZ"}').radioWheelKey, 'z');
console.log('ok');
