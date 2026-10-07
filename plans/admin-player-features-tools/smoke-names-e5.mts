// Claimed names UI (new-features-1006 E.5): the nickname clean-up
// (31 bytes, ".."), the names API client and its error texts, the
// leaderboard's claimed mark and the admin release_claim action. Run from
// the repo root:
//   npx tsx plans/admin-player-features-tools/smoke-names-e5.mts
import assert from 'node:assert/strict';

// player.ts reads the nickname field and localStorage when it loads.
const g = globalThis as Record<string, unknown>;
g.document = {
  getElementById: () => ({ value: '', addEventListener() {} }),
};
g.localStorage = { getItem: () => null, setItem() {} };

const { sanitizePlayerName, cutToBytes, MAX_PLAYER_NAME_BYTES } =
  await import('../../src/client/src/player.ts');
const bytes = (s: string) => new TextEncoder().encode(s).length;

// --- sanitizePlayerName: what the engine keeps (E.1). ---
assert.equal(MAX_PLAYER_NAME_BYTES, 31);
assert.equal(sanitizePlayerName('  Walter  '), 'Walter');
assert.equal(sanitizePlayerName('Wal\tter\n'), 'Wal ter');
assert.equal(sanitizePlayerName('a"b;c\\d'), 'abcd');
assert.equal(sanitizePlayerName('x\u0001y\u007f'), 'xy');
// ".." is refused by the engine on a name change: shortened to ".".
assert.equal(sanitizePlayerName('a..b...c'), 'a.b.c');
assert.equal(sanitizePlayerName('....'), '.');
// ASCII: 31 characters = 31 bytes.
assert.equal(sanitizePlayerName('x'.repeat(40)), 'x'.repeat(31));
// Two-byte letters: 15 fit (30 bytes); the 16th would split at byte 31.
const u = sanitizePlayerName('Ü'.repeat(20));
assert.equal(u, 'Ü'.repeat(15));
assert.equal(bytes(u), 30);
// One ASCII + 15 two-byte = 31 bytes exactly.
assert.equal(sanitizePlayerName('a' + 'é'.repeat(20)), 'a' + 'é'.repeat(15));
// Three-byte (CJK) and four-byte (emoji) characters stay whole.
assert.equal(sanitizePlayerName('漢'.repeat(20)), '漢'.repeat(10));
assert.equal(sanitizePlayerName('😀'.repeat(10)), '😀'.repeat(7));
assert.equal(bytes(sanitizePlayerName('😀'.repeat(10))), 28);
// A cut that ends on a space is trimmed.
assert.equal(sanitizePlayerName('x'.repeat(30) + ' yz'), 'x'.repeat(30));
// Lone surrogates (they'd be U+FFFD on the wire) are dropped.
assert.equal(sanitizePlayerName('a\ud800b\udc00c'), 'abc');
// Colour codes are kept (the engine keeps them; the server matches them).
assert.equal(sanitizePlayerName('^1Wal^7ter'), '^1Wal^7ter');
// Every result is something the server accepts as a claim name
// (claimNameProblem): 1-31 bytes, no " \ ;, no Cc, no "..", no U+FFFD.
for (const input of [
  'Ünal'.repeat(9),
  'a.'.repeat(20) + '.',
  '\u00a0 Walter\u2003',
  'x\ud83d',
  'ĳ'.repeat(31),
]) {
  const out = sanitizePlayerName(input);
  assert.ok(bytes(out) >= 1 && bytes(out) <= 31, `${input}: ${bytes(out)}`);
  assert.ok(!/["\\;]|\p{Cc}|\.\.|\ufffd/u.test(out), `${input} -> ${out}`);
  assert.equal(out, out.trim());
}
assert.equal(cutToBytes('abc', 0), '');
assert.equal(cutToBytes('aé', 2), 'a');
assert.equal(cutToBytes('aé', 3), 'aé');

// --- names/api.ts ---
const api = await import('../../src/client/src/names/api.ts');
assert.ok(api.looksLikeRecoveryCode('KJ7Q-M2XP-9WRT-4HCD'));
assert.ok(api.looksLikeRecoveryCode('kj7q m2xp 9wrt 4hcd'));
assert.ok(!api.looksLikeRecoveryCode('KJ7Q-M2XP-9WRT'));
assert.ok(!api.looksLikeRecoveryCode('KJ7Q-M2XP-9WRT-4HC!'));
assert.ok(!api.looksLikeRecoveryCode(''));

// Error bodies: the names API shape, and checkPost's {error: message}.
assert.deepEqual(
  api.parseNamesError(
    409,
    {
      error: 'device_has_name',
      message: 'this browser already has the name Ann',
      name: 'Ann',
    },
    0
  ),
  {
    status: 409,
    code: 'device_has_name',
    message: 'this browser already has the name Ann',
    name: 'Ann',
    retryAfter: 0,
  }
);
assert.deepEqual(
  api.parseNamesError(403, { error: 'cross-origin request' }, 0),
  { status: 403, code: '', message: 'cross-origin request', retryAfter: 0 }
);
assert.deepEqual(api.parseNamesError(404, undefined, 0), {
  status: 404,
  code: '',
  message: '',
  retryAfter: 0,
});

const err = (status: number, code: string, extra = {}) => ({
  status,
  code,
  message: 'the name must be 1 to 31 bytes',
  retryAfter: 0,
  ...extra,
});
const texts: Array<[string, ReturnType<typeof err>, RegExp]> = [
  ['claim', err(400, 'invalid_name'), /can't be claimed: the name must be/],
  ['signin', err(400, 'invalid_name'), /Type the claimed name/],
  ['signin', err(400, 'invalid_code'), /16 letters and digits/],
  ['signin', err(403, 'wrong_code'), /Wrong name or recovery code/],
  ['claim', err(409, 'taken'), /already claimed that name/],
  [
    'claim',
    err(409, 'device_has_name', { name: 'Ann' }),
    /already has the name “Ann”\. Release this device first/,
  ],
  ['signin', err(409, 'no_claim'), /isn't claimed any more/],
  ['claim', err(409, 'no_claim'), /just released/],
  ['claim', err(429, 'rate_limited'), /Too many requests/],
  [
    'signin',
    err(429, 'locked_out', { retryAfter: 300 }),
    /wrong codes.*in 5 minutes/,
  ],
  ['releaseName', err(429, 'locked_out', { retryAfter: 20 }), /in 1 minute\./],
  [
    'claim',
    err(429, 'too_many_claims', { retryAfter: 3600 }),
    /Too many names claimed.*60 minutes/,
  ],
  ['claim', err(500, 'unavailable'), /isn't available right now/],
  ['claim', err(0, ''), /Couldn't reach the server/],
  ['claim', err(404, ''), /doesn't have claimed names/],
  [
    'claim',
    err(413, 'bad_request', { message: 'body too large' }),
    /refused the request: body too large/,
  ],
  [
    'claim',
    err(403, '', { message: 'cross-origin request' }),
    /refused the request: cross-origin request/,
  ],
  ['claim', err(502, ''), /HTTP 502/],
];
for (const [action, error, want] of texts) {
  const text = api.namesErrorText(action as never, error);
  assert.match(text, want, `${action} ${error.code}: ${text}`);
}

// The fetch wrappers against a fake server.
type Reply = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};
let reply: Reply = { status: 200, body: {} };
const sent: Array<{ url: string; init: RequestInit }> = [];
g.fetch = async (url: string, init: RequestInit) => {
  sent.push({ url, init });
  const headers = new Map(
    Object.entries({
      'Content-Type':
        reply.body === undefined ? 'text/plain' : 'application/json',
      ...reply.headers,
    })
  );
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    headers: { get: (k: string) => headers.get(k) ?? null },
    json: async () => reply.body,
  };
};
reply = { status: 404 };
assert.deepEqual(await api.fetchMyName(), {
  ok: true,
  value: { available: false },
});
reply = { status: 200, body: {} };
assert.deepEqual(await api.fetchMyName(), {
  ok: true,
  value: { available: true, name: '' },
});
reply = { status: 200, body: { name: 'Walter' } };
assert.deepEqual(await api.fetchMyName(), {
  ok: true,
  value: { available: true, name: 'Walter' },
});
assert.equal(sent.at(-1)!.url, '/names/me');
assert.equal(sent.at(-1)!.init.credentials, 'same-origin');

reply = { status: 200, body: { name: 'Walter', code: 'KJ7Q-M2XP-9WRT-4HCD' } };
assert.deepEqual(await api.claimName('Walter'), {
  ok: true,
  value: { name: 'Walter', code: 'KJ7Q-M2XP-9WRT-4HCD' },
});
assert.equal(sent.at(-1)!.url, '/names/claim');
assert.equal(sent.at(-1)!.init.method, 'POST');
assert.equal(sent.at(-1)!.init.body, '{"name":"Walter"}');
assert.deepEqual(sent.at(-1)!.init.headers, {
  'Content-Type': 'application/json',
});

reply = {
  status: 429,
  body: { error: 'locked_out', message: 'too many wrong codes' },
  headers: { 'Retry-After': '300' },
};
const locked = await api.signIn('Walter', 'AAAA-AAAA-AAAA-AAAA');
assert.equal(locked.ok, false);
if (!locked.ok) {
  assert.equal(locked.error.code, 'locked_out');
  assert.equal(locked.error.retryAfter, 300);
}
assert.equal(
  sent.at(-1)!.init.body,
  '{"name":"Walter","code":"AAAA-AAAA-AAAA-AAAA"}'
);

reply = { status: 200, body: {} };
assert.deepEqual(await api.releaseDevice(), { ok: true, value: undefined });
assert.equal(sent.at(-1)!.init.body, '{}');
reply = { status: 200, body: { released: 'Walter' } };
assert.deepEqual(await api.releaseName('', 'KJ7Q'), {
  ok: true,
  value: 'Walter',
});
assert.equal(sent.at(-1)!.init.body, '{"all":true,"code":"KJ7Q"}');
await api.releaseName('walter', 'KJ7Q');
assert.equal(
  sent.at(-1)!.init.body,
  '{"all":true,"code":"KJ7Q","name":"walter"}'
);
// A 200 without the expected field, or the network failing.
reply = { status: 200, body: {} };
const odd = await api.signIn('Walter', 'x');
assert.equal(odd.ok, false);
g.fetch = async () => {
  throw new TypeError('network');
};
const offline = await api.claimName('Walter');
assert.ok(!offline.ok && offline.error.status === 0);

// --- leaderboard.ts: the claimed mark. ---
const lb = await import('../../src/client/src/leaderboard.ts');
const row = {
  rank: 1,
  name: 'Walter',
  kills: 1,
  deaths: 0,
  kd: 1,
  headshots: 0,
  headshotPercent: 0,
};
const board = lb.parseLeaderboard({
  players: [
    { ...row, claimed: true },
    { ...row, rank: 2, name: 'walter', claimed: false },
    { ...row, rank: 3, name: 'Old' },
    { ...row, rank: 4, name: 'Odd', claimed: 'yes' },
  ],
  bots: true,
})!;
assert.deepEqual(
  board.players.map((p) => p.claimed),
  [true, false, false, false]
);
assert.match(lb.noteText(board), /✓ marks a claimed name/);
assert.equal(
  lb.noteText({ players: [], bots: true }),
  'No kills recorded yet. Names are not verified: anyone can play under any name.'
);

// --- admin actions.ts: release_claim. ---
const actions = await import('../../src/client/src/admin/actions.ts');
actions.checkApiOnlyAction({ action: 'claims' });
actions.checkApiOnlyAction({ action: 'release_claim', name: 'Walter' });
assert.throws(() =>
  actions.checkApiOnlyAction({ action: 'release_claim', name: ' ' })
);
assert.throws(() =>
  actions.checkApiOnlyAction({ action: 'release_claim', name: 'é'.repeat(33) })
);

console.log('smoke-names-e5: ok');
