import { checkMessage, chatCommand, centerCommand, aliasCommands } from '/Users/wcarasas/Repos/Walcc.CounterStrike/src/client/src/admin/message-text.ts';
const cases = ['Hello world! Round 2: 5 minutes (go) #1 @all ~ok?', '50%', "don't", 'a//b', 'x^1', 'ok', 'é', 'a'.repeat(121)];
for (const c of cases) console.log(JSON.stringify(c.slice(0,30)), JSON.stringify(checkMessage(c)));
console.log(aliasCommands(chatCommand('Hi there')));
console.log(aliasCommands(centerCommand('Server restarts in 5 minutes.', 'yellow')));
try { centerCommand('x', 'pink' as any); } catch (e) { console.log('throws:', (e as Error).message); }
try { chatCommand('50%'); } catch (e) { console.log('throws:', (e as Error).message); }
// What SV_RemoteCommand runs for each rcon command (every word quoted):
const q = (cmd: string) => cmd.split(/ +/).map((w) => `"${w}" `).join('');
for (const c of aliasCommands(centerCommand('Server restarts in 5 minutes.', 'yellow'))) console.log(q(c));
for (const c of aliasCommands(chatCommand('Hello world! (go) #1 @all ~ok? a&b [x] <3 | `q` =+*'))) console.log(q(c));
