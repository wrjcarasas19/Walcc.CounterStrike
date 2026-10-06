// Run: node --experimental-strip-types --import ./plans/admin-player-features-tools/ts-ext.mjs plans/admin-player-features-tools/smoke-mode41.mts
import * as c from '/Users/wcarasas/Repos/Walcc.CounterStrike/src/client/src/admin/cvars.ts';
import { PRESETS, checkPresets } from '/Users/wcarasas/Repos/Walcc.CounterStrike/src/client/src/admin/presets.ts';
import { actionCommands } from '/Users/wcarasas/Repos/Walcc.CounterStrike/src/client/src/admin/actions.ts';
const ok = (cond: boolean, m: string) => { if (!cond) { console.log('FAIL', m); process.exitCode = 1; } };
const def = c.CVARS.wc_weaponmode;
for (const [raw, v] of [['0', 0], ['1', 1], [' 2 ', 2]] as const) { const r = c.parseCvarValue(def, raw); ok(r.ok && r.value === v, 'parse ' + raw); }
for (const raw of ['3', '-1', '1.5', '', 'x', '1e0', '01x', '100']) ok(!c.parseCvarValue(def, raw).ok, 'bad ' + raw);
ok(c.describeRange(def) === 'normal, knife only or pistols only', 'range ' + c.describeRange(def));
ok(c.choiceName(def, 1) === 'knife only', 'name');
ok(actionCommands({ action: 'cvar', name: 'wc_weaponmode', value: 2 }).join() === 'wc_weaponmode 2', 'cmd');
for (const bad of [3, 1.5, -1]) { let t = false; try { actionCommands({ action: 'cvar', name: 'wc_weaponmode', value: bad }); } catch { t = true; } ok(t, 'badcmd ' + bad); }
ok(checkPresets(PRESETS).length === 0, 'presets');
const mode = Object.fromEntries(PRESETS.map((p) => [p.id, p.values.wc_weaponmode]));
ok(JSON.stringify(mode) === '{"casual":0,"competitive":0,"warmup":0,"knife":1,"pistols":2}', 'modes ' + JSON.stringify(mode));
ok(checkPresets([{ id: 'x', label: 'X', values: { wc_weaponmode: 3 } }]).length === 1, 'bad preset');
console.log('done');
