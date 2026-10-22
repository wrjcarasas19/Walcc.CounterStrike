// Team and character menus: what each option is, by the key the server's
// menu gives it (ReGameDLL_CS 5.30 client.cpp: ShowVGUIMenu for the team
// menus, HandleMenu_ChooseTeam for the character menus; same in HLDS
// mp.dll). Which options a menu offers comes with it (the event's `keys`),
// so a key missing from the server's menu is simply not shown. No DOM here,
// so it can be tested with node (vite.config.ts imports it, so a bad table
// fails the build).

export type Team = 'CT' | 'T';

/** Payload of the bridge's `teammenu` event (cs16-client 0.0.12+). */
export type TeamMenuEvent = {
  open: boolean;
  /** The server's menu title key without '#': "Team_Select", "CT_Select"... */
  menu: string;
  /** Valid keys: bit n for key n + 1, bit 9 for key 0 (close). */
  keys: number;
  team: Team | '';
};

/** The first cs16-client release that sends `teammenu`. */
export const TEAMMENU_EVENT_CLIENT_VERSION = '0.0.12';

export type MenuKind = 'team' | 'class';

export type TeamOption = {
  /** The menu key, picked with `slot<key>`. */
  key: number;
  label: string;
  detail?: string;
  /** Picture in the game files: cstrike/gfx/vgui/<image>.tga. */
  image?: string;
  /** Colours the card: the side it joins. */
  side?: Team;
  /** The server answers this pick with the character menu. */
  thenClass?: boolean;
};

const TEAM_OPTIONS: readonly TeamOption[] = [
  {
    key: 1,
    label: 'Terrorists',
    image: 'terror',
    side: 'T',
    thenClass: true,
  },
  {
    key: 2,
    label: 'Counter-Terrorists',
    image: 'urban',
    side: 'CT',
    thenClass: true,
  },
  // Counter-terrorists on an assassination map: wait in line to be the VIP.
  {
    key: 3,
    label: 'VIP',
    detail: 'Join the VIP queue',
    image: 'vip',
    side: 'CT',
  },
  {
    key: 5,
    label: 'Auto-select',
    detail: 'The team with fewer players',
    thenClass: true,
  },
  { key: 6, label: 'Spectate' },
];

const T_CLASSES: readonly TeamOption[] = [
  { key: 1, label: 'Phoenix Connexion', image: 'terror', side: 'T' },
  { key: 2, label: 'Elite Crew', image: 'leet', side: 'T' },
  { key: 3, label: 'Arctic Avengers', image: 'arctic', side: 'T' },
  { key: 4, label: 'Guerilla Warfare', image: 'guerilla', side: 'T' },
  { key: 5, label: 'Auto-select', side: 'T' },
];

const CT_CLASSES: readonly TeamOption[] = [
  { key: 1, label: 'SEAL Team 6', image: 'urban', side: 'CT' },
  { key: 2, label: 'GSG-9', image: 'gsg9', side: 'CT' },
  { key: 3, label: 'SAS', image: 'sas', side: 'CT' },
  { key: 4, label: 'GIGN', image: 'gign', side: 'CT' },
  { key: 5, label: 'Auto-select', side: 'CT' },
];

/** The menu's bit for a key (0 is bit 9), as in the event's `keys`. */
export function keyBit(key: number): number {
  return key === 0 ? 1 << 9 : 1 << (key - 1);
}

/** The menu has key 0: the player may close it (not on joining). */
export function canCancel(keys: number): boolean {
  return (keys & keyBit(0)) !== 0;
}

export function menuKind(menu: string): MenuKind {
  return menu === 'Terrorist_Select' || menu === 'CT_Select' ? 'class' : 'team';
}

/** A character menu's side; undefined for a team menu. */
export function classSide(menu: string): Team | undefined {
  if (menu === 'Terrorist_Select') return 'T';
  if (menu === 'CT_Select') return 'CT';
  return undefined;
}

/** The options the server's menu accepts, in key order. */
export function menuOptions(menu: string, keys: number): TeamOption[] {
  const side = classSide(menu);
  const all =
    side === 'T' ? T_CLASSES : side === 'CT' ? CT_CLASSES : TEAM_OPTIONS;
  return all.filter((option) => (keys & keyBit(option.key)) !== 0);
}

export function allImages(): string[] {
  const names = new Set<string>();
  for (const option of [...TEAM_OPTIONS, ...T_CLASSES, ...CT_CLASSES]) {
    if (option.image) names.add(option.image);
  }
  return [...names];
}

// Self-check, run by the build (vite.config.ts): keys are menu keys 1-9 and
// unique within a menu.
for (const list of [TEAM_OPTIONS, T_CLASSES, CT_CLASSES]) {
  const seen = new Set<number>();
  for (const option of list) {
    if (!Number.isInteger(option.key) || option.key < 1 || option.key > 9) {
      throw new Error(`team/items: bad key ${option.key} (${option.label})`);
    }
    if (seen.has(option.key)) {
      throw new Error(`team/items: key ${option.key} used twice`);
    }
    seen.add(option.key);
  }
}
