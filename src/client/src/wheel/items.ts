// Radio and quick chat wheel: what it offers, the commands it sends, and the
// geometry that turns a direction or a key into an item. No DOM here, so it
// can be tested with node (vite.config.ts imports it, so a bad table fails
// the build).

export type WheelItem = { label: string; command: string };

export type WheelPage = { id: string; label: string; items: WheelItem[] };

/** Number keys 1-9 pick an item, so a page has at most 9. */
export const PAGE_ITEMS_MAX = 9;

// The direct radio commands of the game dll (CS 1.6 `radioInfo`, the same
// ones the radio1/2/3 menus run), in menu order. All checked in the image's
// cs.so and in the container (see the plan, "Checked in 7").
const RADIO_COMMANDS = [
  'coverme',
  'takepoint',
  'holdpos',
  'regroup',
  'followme',
  'takingfire',
  'go',
  'fallback',
  'sticktog',
  'getinpos',
  'stormfront',
  'report',
  'roger',
  'enemyspot',
  'needbackup',
  'sectorclear',
  'inposition',
  'reportingin',
  'getout',
  'negative',
  'enemydown',
] as const;

type RadioCommand = (typeof RADIO_COMMANDS)[number];

// Fixed team chat lines. Only letters, digits, spaces and `! ? .`: no `%`
// (cs16-client prints some text as a printf format), no `" ; \` (command
// syntax), no `@` (AMXX sends `say_team @...` to admins), no `/` (comments
// and chat commands), no `' ,` (single-character tokens for the engine's
// tokenizer).
const CHAT_LINE_PATTERN = /^[A-Za-z0-9!?.]+(?: [A-Za-z0-9!?.]+)*$/;
export const CHAT_LINE_MAX_LENGTH = 48;

const COMMAND_PATTERN = new RegExp(
  `^(?:${RADIO_COMMANDS.join('|')}|say_team "[A-Za-z0-9!?. ]{1,${CHAT_LINE_MAX_LENGTH}}")$`
);

export function checkChatLine(text: string): boolean {
  return text.length <= CHAT_LINE_MAX_LENGTH && CHAT_LINE_PATTERN.test(text);
}

function radio(command: RadioCommand, label: string): WheelItem {
  return { label, command };
}

function chat(text: string): WheelItem {
  if (!checkChatLine(text)) throw new Error(`Invalid chat line: ${text}`);
  return { label: text, command: `say_team "${text}"` };
}

export const PAGES: readonly WheelPage[] = [
  {
    id: 'commands',
    label: 'Commands',
    items: [
      radio('coverme', 'Cover me'),
      radio('takepoint', 'Take the point'),
      radio('holdpos', 'Hold position'),
      radio('regroup', 'Regroup'),
      radio('followme', 'Follow me'),
      radio('takingfire', 'Taking fire'),
    ],
  },
  {
    id: 'group',
    label: 'Group',
    items: [
      radio('go', 'Go go go'),
      radio('fallback', 'Fall back'),
      radio('sticktog', 'Stick together'),
      radio('getinpos', 'Get in position'),
      radio('stormfront', 'Storm the front'),
      radio('report', 'Report in'),
    ],
  },
  {
    id: 'report',
    label: 'Report',
    items: [
      radio('roger', 'Roger'),
      radio('enemyspot', 'Enemy spotted'),
      radio('needbackup', 'Need backup'),
      radio('sectorclear', 'Sector clear'),
      radio('inposition', 'In position'),
      radio('reportingin', 'Reporting in'),
      radio('getout', 'Get out of there'),
      radio('negative', 'Negative'),
      radio('enemydown', 'Enemy down'),
    ],
  },
  {
    id: 'chat',
    label: 'Team chat',
    items: [
      chat('Nice shot!'),
      chat('Thanks!'),
      chat('Sorry!'),
      chat('Drop me a weapon please'),
      chat('Rush A'),
      chat('Rush B'),
      chat('Wait for me'),
      chat('Good game'),
    ],
  },
];

/**
 * The console command for an item, checked again against the allowlist
 * (throws for anything else).
 */
export function itemCommand(item: WheelItem): string {
  if (!COMMAND_PATTERN.test(item.command)) {
    throw new Error(`Refusing to run an unsafe command: ${item.command}`);
  }
  return item.command;
}

/**
 * The item in direction (dx, dy) (screen coordinates, y down) on a wheel of
 * count items, item 0 at the top and the rest clockwise; -1 inside the dead
 * zone or when there are no items.
 */
export function sectorAt(
  dx: number,
  dy: number,
  count: number,
  deadZone: number
): number {
  if (count <= 0 || !(Math.hypot(dx, dy) >= deadZone)) return -1;
  const turn = 2 * Math.PI;
  const angle = (Math.atan2(dx, -dy) + turn) % turn;
  const size = turn / count;
  return Math.floor((angle + size / 2) / size) % count;
}

/** Centre angle of an item in degrees, clockwise from the top. */
export function sectorAngle(index: number, count: number): number {
  return (index * 360) / count;
}

/** Index of the item for Digit1-9 / Numpad1-9, or -1. */
export function itemIndexForKey(code: string): number {
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  return match ? Number(match[1]) - 1 : -1;
}

/** The page index delta pages away, wrapping around. */
export function stepPage(index: number, delta: number, count: number): number {
  return (((index + delta) % count) + count) % count;
}

/** Keeps a vector inside a circle of radius max (for the pointer dot). */
export function clampVector(
  dx: number,
  dy: number,
  max: number
): { x: number; y: number } {
  const length = Math.hypot(dx, dy);
  if (length <= max || length === 0) return { x: dx, y: dy };
  return { x: (dx * max) / length, y: (dy * max) / length };
}

// The key setting (settings/schema.ts `radioWheelKey`). Matched by the
// character, like the engine's binds ("z" is `radio1` in stock CS 1.6), so it
// follows the keyboard layout.
export type WheelKey = 'z' | 'v' | 'off';

export function wheelKeyMatches(
  setting: WheelKey,
  event: Pick<KeyboardEvent, 'key' | 'altKey' | 'metaKey'>
): boolean {
  if (setting === 'off' || event.altKey || event.metaKey) return false;
  return event.key.toLowerCase() === setting;
}

// Checked at module load: a bad table fails the build.
for (const page of PAGES) {
  if (page.items.length < 2 || page.items.length > PAGE_ITEMS_MAX) {
    throw new Error(`Wheel page ${page.id} needs 2-${PAGE_ITEMS_MAX} items`);
  }
  for (const item of page.items) itemCommand(item);
}
