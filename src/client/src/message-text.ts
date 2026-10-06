// Checks the text of a message: admin server messages (the admin menu, which
// also builds the commands that show them here) and player chat (chat.ts).
// No DOM here, so it can be tested on its own.
//
// How an admin message travels (Xash3D FWGS d3bc7fab, AMX Mod X 1.10, see
// Dockerfile):
// 1. The browser runs `rcon <command>`. Cmd_TokenizeString splits it into
//    words (COM_ParseFileSafe): `"` starts a quoted word, `//` at the start
//    of a word drops the rest of the line, and `{` `}` `'` `,` are words of
//    their own. With cmd_scripting 1, `$name` is replaced by a cvar's value.
// 2. CL_Rcon_f sends the words joined by single spaces (`"` escaped as `\"`,
//    `$` doubled with cmd_scripting 1).
// 3. The server splits the packet again the same way and runs
//    `"amx_say" "word1" "word2" ` (SV_RemoteCommand quotes every word and
//    leaves a space at the end).
// 4. adminchat.amxx reads that line with read_args, so it gets
//    `"word1" "word2" `; remove_quotes only strips a quote at both ends, and
//    the last character is a space, so players would see every word in
//    quotes (`amx_csay` also cuts the colour off at the wrong place and
//    shows `" "word1" ...`). Checked in the server console.
//
// To get the plain text, the message goes through an alias: `alias web_msg
// amx_say word1 word2` is run as `"alias" "web_msg" "amx_say" "word1" ...`
// too, but Cmd_Alias_f joins the words with single spaces, without quotes.
// Running `web_msg` then puts `amx_say word1 word2` in the command buffer
// (a copy, so clearing the alias right after is safe), and read_args gets
// `word1 word2`. The alias text is split a third time by the command
// buffer: `;` and newlines end the command and `//` starts a comment.
//
// AMX Mod X sends the chat line as a TextMsg, which the game uses as a C
// format string (CHudTextMessage::MsgFunc_TextMsg), so `%` must not reach it.
//
// So the allowlist is printable ASCII without:
// - `"` `;` `\`: end the command or escape (sendRcon refuses them too);
// - `$`: cvar expansion;
// - `{` `}` `'` `,`: split into separate words ("don't" would show as
//   "don ' t");
// - `^`: colour codes in the engine console;
// - `%`: format string in the game's TextMsg handler;
// and the text can't contain `//`, which would cut it off. Several spaces
// in a row become one (step 3 drops them). src/server/admin_actions.go
// checks admin messages again with the same rules.
//
// Player chat goes another way: the browser runs `say "<text>"` with
// Cmd_ExecuteString, and the engine forwards the raw rest of the line (see
// sendChat in chat.ts). Nothing splits the text into words, so `'` `,` `{`
// `}` arrive unchanged and checkChatMessage allows them too; several spaces
// in a row are kept. The rest of the list above still applies: `"` `;` `\`
// `$` `^` `%`, non-ASCII and `//` are refused for chat as well (`%` because
// the game turns it into a space, `$` for cmd_scripting, the others to keep
// one simple rule for the player and the console line).

/** Longest admin message, in characters. */
export const MESSAGE_MAX_LENGTH = 120;

/**
 * Longest chat message, in characters. Host_Say cuts the text at 125 bytes
 * minus the length of its format name (as few as 104 for a dead player), so
 * the limit stays under that and nothing is cut by the server.
 */
export const CHAT_MAX_LENGTH = 100;

/** Colours `amx_csay` knows (English names from adminchat.txt). */
export const MESSAGE_COLORS = [
  'white',
  'red',
  'green',
  'blue',
  'yellow',
  'magenta',
  'cyan',
  'orange',
  'ocean',
  'maroon',
] as const;
export type MessageColor = (typeof MESSAGE_COLORS)[number];

/** Server-side alias the message is put in; see the top of this file. */
const ALIAS = 'web_msg';

/** The characters a message may contain, and what is said about `//`. */
type MessageRules = {
  allowed: RegExp;
  notAllowed: RegExp;
  slashes: string;
  maxLength: number;
};

const ADMIN_RULES: MessageRules = {
  allowed: /^[ !#&()*+\-./0-9:<=>?@A-Z[\]_`a-z|~]*$/,
  notAllowed: /[^ !#&()*+\-./0-9:<=>?@A-Z[\]_`a-z|~]/gu,
  slashes: 'Not allowed: //. The server would cut the message off there.',
  maxLength: MESSAGE_MAX_LENGTH,
};

// The admin set plus ' , { } (see the top of this file).
const CHAT_RULES: MessageRules = {
  allowed: /^[ !#&'()*+,\-./0-9:<=>?@A-Z[\]_`a-z{|}~]*$/,
  notAllowed: /[^ !#&'()*+,\-./0-9:<=>?@A-Z[\]_`a-z{|}~]/gu,
  slashes: 'Not allowed: //. Remove it to send the message.',
  maxLength: CHAT_MAX_LENGTH,
};

export type MessageCheck =
  | { ok: true; text: string }
  | { ok: false; error: string };

/** Names a character for an error message. */
function describe(char: string): string {
  const code = char.codePointAt(0)!;
  if (code < 0x20 || code === 0x7f) return 'control characters (tabs...)';
  if (code > 0x7f) return `${char} (only plain ASCII)`;
  return char;
}

/**
 * Spaces at both ends are trimmed (the engine or the game drops them
 * anyway); nothing else is changed: any other character that can't be sent
 * is reported, never removed.
 */
function check(raw: string, rules: MessageRules): MessageCheck {
  const text = raw.trim();
  if (text === '') return { ok: false, error: 'Type a message.' };
  if (!rules.allowed.test(text)) {
    const bad = [...new Set(Array.from(text.match(rules.notAllowed) ?? []))];
    const names = [...new Set(bad.map(describe))];
    return {
      ok: false,
      error: `Not allowed: ${names.join('  ')}. Remove ${
        bad.length === 1 ? 'it' : 'them'
      } to send the message.`,
    };
  }
  if (text.includes('//')) return { ok: false, error: rules.slashes };
  const length = Array.from(text).length;
  if (length > rules.maxLength) {
    return {
      ok: false,
      error: `Too long: ${length} characters, the limit is ${rules.maxLength}.`,
    };
  }
  return { ok: true, text };
}

/** Checks a server message typed in the admin menu. */
export function checkMessage(raw: string): MessageCheck {
  return check(raw, ADMIN_RULES);
}

/** Checks a chat message typed in the HUD's chat input (say / say_team). */
export function checkChatMessage(raw: string): MessageCheck {
  return check(raw, CHAT_RULES);
}

function checked(raw: string): string {
  const result = checkMessage(raw);
  if (!result.ok) throw new Error(result.error);
  return result.text;
}

/** `amx_say <text>`: a chat line; throws if the text doesn't pass. */
export function chatCommand(raw: string): string {
  return `amx_say ${checked(raw)}`;
}

/** `amx_csay <color> <text>`: center of the screen; throws if invalid. */
export function centerCommand(raw: string, color: MessageColor): string {
  if (!MESSAGE_COLORS.includes(color)) {
    throw new Error(`Unknown colour: ${color}`);
  }
  return `amx_csay ${color} ${checked(raw)}`;
}

/**
 * The rcon commands that run `command` through the alias, so the words
 * reach AMX Mod X without quotes: define it, run it, clear it (an empty
 * alias does nothing, so a lost definition never repeats an old message).
 */
export function aliasCommands(command: string): readonly string[] {
  return [`alias ${ALIAS} ${command}`, ALIAS, `alias ${ALIAS}`];
}
