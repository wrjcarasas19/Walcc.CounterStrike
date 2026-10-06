import * as b from '/Users/wcarasas/Repos/Walcc.CounterStrike/src/client/src/admin/bot-commands.ts';
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } };
ok(b.addBotCommand('CT') === 'yb add_ct' && b.addBotCommand('T') === 'yb add_t', 'add');
ok(b.kickBotCommand() === 'yb kick' && b.kickAllBotsCommand() === 'yb kickall instant', 'kick');
for (let i = 0; i <= 4; i++) ok(b.difficultyCommand(i) === `yb_difficulty ${i}`, 'diff' + i);
for (const bad of [-1, 5, 1.5, NaN]) { let t = false; try { b.difficultyCommand(bad); } catch { t = true; } ok(t, 'baddiff ' + bad); }
for (const [raw, v] of [['0', 0], ['6', 6], [' 32 ', 32], ['07', 7]] as const) { const r = b.parseBotQuota(raw); ok(r.ok && r.value === v, 'quota ' + raw); }
for (const raw of ['33', '-1', '1.5', '1e1', '', 'x', '100', '+3', '0x1', '٣']) ok(!b.parseBotQuota(raw).ok, 'badquota ' + raw);
ok(JSON.stringify(b.botQuotaCommands(6)) === '["yb_quota_mode fill","yb_quota 6"]', 'qc');
for (const bad of [33, -1, 2.5]) { let t = false; try { b.botQuotaCommands(bad); } catch { t = true; } ok(t, 'badqc ' + bad); }
for (let i = 0; i <= 32; i++) b.botQuotaCommands(i);
console.log('done');
