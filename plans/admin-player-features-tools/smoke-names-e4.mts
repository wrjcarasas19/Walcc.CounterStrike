// Claimed names on the login page (new-features-1006 E.4). Run from the
// repo root:
//   npx tsx plans/admin-player-features-tools/smoke-names-e4.mts
// (or node --experimental-strip-types --import ./ts-ext.mjs on Node 22+).
import assert from 'node:assert/strict';

// player.ts reads the nickname field and localStorage when it loads.
type Listener = () => void;
const listeners: Listener[] = [];
const input = {
  value: '',
  addEventListener: (_: string, fn: Listener) => listeners.push(fn),
};
const note = { textContent: '', dataset: {} as Record<string, string> };
const g = globalThis as Record<string, unknown>;
g.document = {
  getElementById: (id: string) =>
    id === 'nickname-input' ? input : id === 'nickname-status' ? note : null,
};
g.localStorage = { getItem: () => 'Walter' };
g.window = globalThis;

// A fake /names/status: Walter is claimed (mine with the cookie), others
// not; "slow" answers late; "broken" fails.
const asked: string[] = [];
let cookie = false;
const pendingReplies: Array<() => void> = [];
g.fetch = (url: string, init: { signal: AbortSignal }) => {
  const name = new URL(url, 'http://x').searchParams.get('name') ?? '';
  asked.push(name);
  const key = name.toLowerCase().trim();
  if (key === 'broken') return Promise.reject(new TypeError('network'));
  if (key === 'off') {
    return Promise.resolve({ ok: false, json: async () => ({}) });
  }
  const body = { claimed: key === 'walter', mine: key === 'walter' && cookie };
  const reply = Promise.resolve({ ok: true, json: async () => body });
  if (key !== 'slow') return reply;
  return new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () =>
      reject(new DOMException('aborted', 'AbortError'))
    );
    pendingReplies.push(() => resolve(reply));
  });
};

const { parseNameStatus, nameStatusMessage, nameToCheck, startNameStatus } =
  await import('../../src/client/src/name-status.ts');

// Pure parts.
assert.deepEqual(parseNameStatus({ claimed: true, mine: false }), {
  claimed: true,
  mine: false,
});
assert.equal(parseNameStatus({ claimed: 'yes', mine: false }), undefined);
assert.equal(parseNameStatus({}), undefined);
assert.equal(parseNameStatus(null), undefined);
assert.equal(nameStatusMessage(undefined), null);
assert.equal(nameStatusMessage({ claimed: false, mine: false }), null);
assert.deepEqual(nameStatusMessage({ claimed: true, mine: false }), {
  kind: 'taken',
  text: 'This name is claimed by someone else',
});
assert.deepEqual(nameStatusMessage({ claimed: true, mine: true }), {
  kind: 'mine',
  text: '✓ yours',
});
// The name is asked about as the game would get it.
assert.equal(nameToCheck('  Wal"ter  '), 'Walter');
assert.equal(nameToCheck('   '), '');

const tick = () => new Promise((r) => setTimeout(r, 0));
const type = async (value: string) => {
  input.value = value;
  listeners.forEach((fn) => fn());
  await new Promise((r) => setTimeout(r, 450)); // past the debounce
  await tick();
};

// The saved name is checked at start.
input.value = 'Walter';
startNameStatus();
await tick();
assert.deepEqual(asked, ['Walter']);
assert.equal(note.textContent, 'This name is claimed by someone else');
assert.equal(note.dataset.kind, 'taken');

// Typing: one request per pause, the note follows.
asked.length = 0;
input.value = 'Ann';
listeners.forEach((fn) => fn());
assert.equal(note.textContent, '', 'old answer hidden while typing');
await type('Annie');
assert.deepEqual(asked, ['Annie']);
assert.equal(note.textContent, '');
assert.equal(note.dataset.kind, undefined);

cookie = true;
await type(' walter ');
assert.equal(note.textContent, '✓ yours');
assert.equal(note.dataset.kind, 'mine');

// Server without claims, network errors: nothing shown.
await type('off');
assert.equal(note.textContent, '');
await type('broken');
assert.equal(note.textContent, '');

// A late answer for an older name is dropped.
await type('slow');
await type('Walter');
pendingReplies.forEach((resolve) => resolve());
await tick();
assert.equal(note.textContent, '✓ yours');

// Empty field: no request, nothing shown.
asked.length = 0;
await type('');
assert.deepEqual(asked, []);
assert.equal(note.textContent, '');

console.log('smoke-names-e4: ok');
