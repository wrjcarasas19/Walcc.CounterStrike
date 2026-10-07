// Run: node --experimental-strip-types --import ./plans/admin-player-features-tools/ts-ext.mjs plans/admin-player-features-tools/smoke-map42.mts
import { actionCommands, checkApiOnlyAction, isAmxxMap, VOTE_MAPS_MAX } from '../../src/client/src/admin/actions.ts';
const ok = (cond: boolean, m: string) => { if (!cond) { console.log('FAIL', m); process.exitCode = 1; } };
const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
ok(VOTE_MAPS_MAX === 4, 'max 4');
ok(actionCommands({ action: 'set_nextmap', map: 'de_aztec' }).join('|') === 'amx_cvar amx_nextmap de_aztec|amxx pause mapchooser.amxx', 'set');
ok(actionCommands({ action: 'votemap', maps: ['de_aztec'] }).join() === 'amx_votemap de_aztec', 'vote 1');
ok(actionCommands({ action: 'votemap', maps: ['a', 'b', 'c', 'd'] }).join() === 'amx_votemap a b c d', 'vote 4');
for (const maps of [[], ['a', 'b', 'c', 'd', 'e'], ['a', 'a'], ['a;quit'], ['a b'], [''], ['x'.repeat(32)]]) ok(throws(() => actionCommands({ action: 'votemap', maps })), 'bad vote ' + maps.join(','));
for (const map of ['', 'a;b', 'a b', '"a"', 'x'.repeat(32)]) ok(throws(() => actionCommands({ action: 'set_nextmap', map })), 'bad set ' + map);
ok(isAmxxMap('x'.repeat(31)) && !isAmxxMap('x'.repeat(32)), 'length');
ok(!throws(() => checkApiOnlyAction({ action: 'nextmap' })), 'nextmap api');
console.log('done');
