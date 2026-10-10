const PLAYER_NAME_KEY = 'player-name';
const DEFAULT_PLAYER_NAME = 'Player';
// The engine stores names in a 32-byte buffer, including the terminator,
// and cuts longer ones at 31 bytes, even in the middle of a character.
export const MAX_PLAYER_NAME_BYTES = 31;

const playerNameInput = document.getElementById(
  'nickname-input'
) as HTMLInputElement;

playerNameInput.value = savedPlayerName();

// The name is sent as `name "<name>"`, so characters that would end the
// quoted argument or the command are removed. The rest follows the engine
// (Xash3D's userinfo rules), so the name the server sees is exactly this
// one, which matters for claimed names: lone surrogates (they'd become
// U+FFFD) are dropped, ".." (the engine refuses a name containing it) is
// shortened to ".", and the name is cut at 31 UTF-8 bytes on a character
// boundary rather than in the middle of one as the engine would.
export function sanitizePlayerName(name: string): string {
  const cleaned = name
    .replace(/[";\\]|(?!\s)\p{Cc}|\p{Cs}/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/\.{2,}/g, '.')
    .trim();
  return cutToBytes(cleaned, MAX_PLAYER_NAME_BYTES).trim();
}

/** The longest start of text that is at most maxBytes in UTF-8. */
export function cutToBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

/**
 * The nickname in the field, cleaned up; '' if there is none. The field is
 * kept here, so this still works in game after the login page is gone.
 */
export function currentPlayerName(): string {
  return sanitizePlayerName(playerNameInput.value);
}

/** Puts name in the nickname field without saving it. */
export function setPlayerNameField(name: string): void {
  playerNameInput.value = name;
}

export function getPlayerName(): string {
  return sanitizePlayerName(playerNameInput.value) || DEFAULT_PLAYER_NAME;
}

export function cachePlayerName(): void {
  const name = sanitizePlayerName(playerNameInput.value);
  playerNameInput.value = name;
  localStorage.setItem(PLAYER_NAME_KEY, name);
}

/** Puts name in the nickname field and saves it, like a Download does. */
export function savePlayerName(name: string): void {
  playerNameInput.value = name;
  cachePlayerName();
}

/**
 * The nickname saved by the last Download, cleaned up like the login form
 * does; empty if there is none (or storage can't be read).
 */
export function savedPlayerName(): string {
  try {
    return sanitizePlayerName(localStorage.getItem(PLAYER_NAME_KEY) ?? '');
  } catch {
    return '';
  }
}
