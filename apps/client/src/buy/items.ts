// Buy menu: what the game sells, in the stock menus' order so the number keys
// still match (B 4 2 buys the AK-47 for terrorists). Prices, team lists and
// buy aliases are ReGameDLL_CS 5.30's (weapontype.cpp, client.cpp
// HandleBuyAliasCommands); the server checks all of them again (buy zone,
// buy time, money, apps/amxx/wc_weaponmode.sma), so a wrong entry here only
// greys out the wrong button. No DOM here, so it can be tested with node
// (vite.config.ts imports it, so a bad table fails the build).

export type Team = 'CT' | 'T';

export type BuyItem = {
  label: string;
  /** undefined: depends on the weapon (ammo). */
  price?: number;
  /** The game's buy alias, run as a console command. */
  command: string;
  /** Picture in the game files: cstrike/gfx/vgui/<image>.tga. */
  image?: string;
  /** Weapons only: who may buy it on an assassination (as_) map. */
  assassination?: readonly Team[];
};

export type CategoryId =
  'pistols' | 'shotguns' | 'smgs' | 'rifles' | 'machineguns' | 'equipment';

/** One line of the main menu: a category, or an item bought right away. */
export type MainEntry =
  | { kind: 'category'; id: CategoryId; label: string }
  | { kind: 'item'; item: BuyItem };

/** Payload of the bridge's `buymenu` event (cs16-client 0.0.11+). */
export type BuyMenuEvent = {
  open: boolean;
  /** The server's menu title key without '#': "Buy", "CT_BuyRifle"... */
  menu: string;
  team: Team | '';
  map: string;
};

/** The first cs16-client release that sends `buymenu`. */
export const BUYMENU_EVENT_CLIENT_VERSION = '0.0.11';

const BOTH: readonly Team[] = ['CT', 'T'];
const CT_ONLY: readonly Team[] = ['CT'];
const T_ONLY: readonly Team[] = ['T'];

// `assassination` is CanBuyWeaponByMaptype's list for maps with a VIP
// safety zone.
const ITEMS = {
  glock: {
    label: 'Glock-18',
    price: 400,
    command: 'glock',
    image: 'glock18',
    assassination: BOTH,
  },
  usp: {
    label: 'USP',
    price: 500,
    command: 'usp',
    image: 'usp45',
    assassination: BOTH,
  },
  p228: {
    label: 'P228',
    price: 600,
    command: 'p228',
    image: 'p228',
    assassination: BOTH,
  },
  deagle: {
    label: 'Desert Eagle',
    price: 650,
    command: 'deagle',
    image: 'deserteagle',
    assassination: BOTH,
  },
  fiveseven: {
    label: 'Five-SeveN',
    price: 750,
    command: 'fn57',
    image: 'fiveseven',
    assassination: CT_ONLY,
  },
  elites: {
    label: 'Dual Elites',
    price: 800,
    command: 'elites',
    image: 'elites',
    assassination: T_ONLY,
  },
  m3: {
    label: 'M3 Super 90',
    price: 1700,
    command: 'm3',
    image: 'm3',
    assassination: CT_ONLY,
  },
  xm1014: {
    label: 'XM1014',
    price: 3000,
    command: 'xm1014',
    image: 'xm1014',
    assassination: CT_ONLY,
  },
  tmp: {
    label: 'TMP',
    price: 1250,
    command: 'tmp',
    image: 'tmp',
    assassination: CT_ONLY,
  },
  mac10: {
    label: 'MAC-10',
    price: 1400,
    command: 'mac10',
    image: 'mac10',
    assassination: T_ONLY,
  },
  mp5: {
    label: 'MP5',
    price: 1500,
    command: 'mp5',
    image: 'mp5',
    assassination: CT_ONLY,
  },
  ump45: {
    label: 'UMP45',
    price: 1700,
    command: 'ump45',
    image: 'ump45',
    assassination: BOTH,
  },
  p90: {
    label: 'P90',
    price: 2350,
    command: 'p90',
    image: 'p90',
    assassination: CT_ONLY,
  },
  famas: {
    label: 'FAMAS',
    price: 2250,
    command: 'famas',
    image: 'famas',
    assassination: CT_ONLY,
  },
  galil: {
    label: 'Galil',
    price: 2000,
    command: 'galil',
    image: 'galil',
    assassination: T_ONLY,
  },
  ak47: {
    label: 'AK-47',
    price: 2500,
    command: 'ak47',
    image: 'ak47',
    assassination: T_ONLY,
  },
  scout: {
    label: 'Scout',
    price: 2750,
    command: 'scout',
    image: 'scout',
    assassination: [],
  },
  m4a1: {
    label: 'M4A1',
    price: 3100,
    command: 'm4a1',
    image: 'm4a1',
    assassination: CT_ONLY,
  },
  aug: {
    label: 'AUG',
    price: 3500,
    command: 'aug',
    image: 'aug',
    assassination: CT_ONLY,
  },
  sg552: {
    label: 'SG 552',
    price: 3500,
    command: 'sg552',
    image: 'sg552',
    assassination: [],
  },
  sg550: {
    label: 'SG 550',
    price: 4200,
    command: 'sg550',
    image: 'sg550',
    assassination: CT_ONLY,
  },
  awp: {
    label: 'AWP',
    price: 4750,
    command: 'awp',
    image: 'awp',
    assassination: T_ONLY,
  },
  g3sg1: {
    label: 'G3SG1',
    price: 5000,
    command: 'g3sg1',
    image: 'g3sg1',
    assassination: [],
  },
  m249: {
    label: 'M249',
    price: 5750,
    command: 'm249',
    image: 'm249',
    assassination: CT_ONLY,
  },
  vest: { label: 'Kevlar', price: 650, command: 'vest', image: 'kevlar' },
  vesthelm: {
    label: 'Kevlar + Helmet',
    price: 1000,
    command: 'vesthelm',
    image: 'kevlar_helmet',
  },
  flash: {
    label: 'Flashbang',
    price: 200,
    command: 'flash',
    image: 'flashbang',
  },
  hegren: {
    label: 'HE Grenade',
    price: 300,
    command: 'hegren',
    image: 'hegrenade',
  },
  sgren: {
    label: 'Smoke Grenade',
    price: 300,
    command: 'sgren',
    image: 'smokegrenade',
  },
  nvgs: {
    label: 'Night Vision',
    price: 1250,
    command: 'nvgs',
    image: 'nightvision',
  },
  defuser: {
    label: 'Defuse Kit',
    price: 200,
    command: 'defuser',
    image: 'defuser',
  },
  shield: {
    label: 'Tactical Shield',
    price: 2200,
    command: 'shield',
    image: 'shield',
    assassination: CT_ONLY,
  },
  primammo: { label: 'Primary ammo', command: 'primammo' },
  secammo: { label: 'Secondary ammo', command: 'secammo' },
} satisfies Record<string, BuyItem>;

type ItemId = keyof typeof ITEMS;

// Each team's submenus in the stock order (BuyPistol, BuyRifle... in
// client.cpp; the equipment menu's 7 and 8 are CT only).
const CATEGORIES: {
  id: CategoryId;
  label: string;
  CT: readonly ItemId[];
  T: readonly ItemId[];
}[] = [
  {
    id: 'pistols',
    label: 'Pistols',
    CT: ['glock', 'usp', 'p228', 'deagle', 'fiveseven'],
    T: ['glock', 'usp', 'p228', 'deagle', 'elites'],
  },
  {
    id: 'shotguns',
    label: 'Shotguns',
    CT: ['m3', 'xm1014'],
    T: ['m3', 'xm1014'],
  },
  {
    id: 'smgs',
    label: 'SMGs',
    CT: ['tmp', 'mp5', 'ump45', 'p90'],
    T: ['mac10', 'mp5', 'ump45', 'p90'],
  },
  {
    id: 'rifles',
    label: 'Rifles',
    CT: ['famas', 'scout', 'm4a1', 'aug', 'sg550', 'awp'],
    T: ['galil', 'ak47', 'scout', 'sg552', 'awp', 'g3sg1'],
  },
  { id: 'machineguns', label: 'Machine guns', CT: ['m249'], T: ['m249'] },
  {
    id: 'equipment',
    label: 'Equipment',
    CT: [
      'vest',
      'vesthelm',
      'flash',
      'hegren',
      'sgren',
      'nvgs',
      'defuser',
      'shield',
    ],
    T: ['vest', 'vesthelm', 'flash', 'hegren', 'sgren', 'nvgs'],
  },
];

function category(id: CategoryId) {
  return CATEGORIES.find((c) => c.id === id)!;
}

/** The main menu: keys 1-8 in order (6 and 7 buy ammo right away). */
export function mainEntries(): MainEntry[] {
  const entry = (id: CategoryId): MainEntry => ({
    kind: 'category',
    id,
    label: category(id).label,
  });
  return [
    entry('pistols'),
    entry('shotguns'),
    entry('smgs'),
    entry('rifles'),
    entry('machineguns'),
    { kind: 'item', item: ITEMS.primammo },
    { kind: 'item', item: ITEMS.secammo },
    entry('equipment'),
  ];
}

/** A category's items for a team, in the order of their number keys. */
export function categoryItems(id: CategoryId, team: Team): BuyItem[] {
  return category(id)[team].map((item) => ITEMS[item]);
}

/** Every picture the menu shows, to load them in one go. */
export function allImages(): string[] {
  const images = new Set<string>();
  for (const item of Object.values(ITEMS) as BuyItem[]) {
    if (item.image) images.add(item.image);
  }
  return [...images];
}

/**
 * The category a submenu key opens ("CT_BuyRifle", "AS_T_BuyRifle" ->
 * rifles), undefined for the main menu or an unknown key.
 */
export function categoryForMenu(menu: string): CategoryId | undefined {
  const name = menu.replace(/^(AS_)?(D?CT_|D?T_)?/, '');
  switch (name) {
    case 'BuyPistol':
      return 'pistols';
    case 'BuyShotgun':
      return 'shotguns';
    case 'BuySubMachineGun':
      return 'smgs';
    case 'BuyRifle':
      return 'rifles';
    case 'BuyMachineGun':
      return 'machineguns';
    case 'BuyItem':
      return 'equipment';
  }
  return undefined;
}

/**
 * Assassination maps (a VIP escorted to a safety zone) restrict weapons; the
 * server knows by the map's func_vip_safetyzone, the page by its as_ prefix.
 */
export function isAssassinationMap(map: string): boolean {
  return map.toLowerCase().startsWith('as_');
}

/** False when the server would refuse the item for that team and map. */
export function canBuy(
  item: BuyItem,
  team: Team,
  assassination: boolean
): boolean {
  if (!assassination || !item.assassination) return true;
  return item.assassination.includes(team);
}

// Checked at module load: a bad table fails the build. Commands go to the
// console as they are, so only plain words are allowed.
for (const item of Object.values(ITEMS) as BuyItem[]) {
  if (!/^[a-z0-9]+$/.test(item.command)) {
    throw new Error(`Buy command ${item.command} is not a plain word`);
  }
  if (item.image !== undefined && !/^[a-z0-9_]+$/.test(item.image)) {
    throw new Error(`Buy picture ${item.image} is not a plain file name`);
  }
}
for (const c of CATEGORIES) {
  for (const team of ['CT', 'T'] as const) {
    if (c[team].length < 1 || c[team].length > 9) {
      throw new Error(`Buy category ${c.id} needs 1-9 items for ${team}`);
    }
  }
}
