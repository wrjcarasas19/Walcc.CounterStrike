const PLAYER_NAME_KEY = 'player-name';

const playerNameInput = document.getElementById(
  'nickname-input'
) as HTMLInputElement;

playerNameInput.value = localStorage.getItem(PLAYER_NAME_KEY) ?? '';

export function getPlayerName(): string {
  return playerNameInput.value.trim();
}

export function cachePlayerName(): void {
  localStorage.setItem(PLAYER_NAME_KEY, getPlayerName());
}
