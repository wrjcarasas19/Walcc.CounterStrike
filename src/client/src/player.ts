const PLAYER_NAME_KEY = 'player-name';
const DEFAULT_PLAYER_NAME = 'Player';
// The engine stores names in a 32-byte buffer, including the terminator.
const MAX_PLAYER_NAME_LENGTH = 31;

const playerNameInput = document.getElementById(
  'nickname-input'
) as HTMLInputElement;

playerNameInput.value = savedPlayerName();

// The name is sent as `name "<name>"`, so characters that would end the
// quoted argument or the command are removed.
export function sanitizePlayerName(name: string): string {
  const cleaned = name
    .replace(/[";\\]|(?!\s)\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, MAX_PLAYER_NAME_LENGTH).join('').trim();
}

export function getPlayerName(): string {
  return sanitizePlayerName(playerNameInput.value) || DEFAULT_PLAYER_NAME;
}

export function cachePlayerName(): void {
  const name = sanitizePlayerName(playerNameInput.value);
  playerNameInput.value = name;
  localStorage.setItem(PLAYER_NAME_KEY, name);
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
