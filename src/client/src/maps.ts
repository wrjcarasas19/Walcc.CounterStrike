import { delMany, get, keys, set } from 'idb-keyval';
import type { Xash3D } from 'xash3d-fwgs';
import { updateProgress } from './desktop';

// Maps the server has but the game zip lacks are fetched over HTTP and
// written into the engine's filesystem before connecting. The engine's own
// download stays off (cl_allowdownload 0): it crashes this dedicated server.
const MAPS_URL = '/maps/';
const MAPS_DIR = '/rodir/cstrike/maps';
const CACHE_PREFIX = 'map:';
// While in game, maps added to the server since the page loaded are fetched
// in the background, so a later changelevel to them doesn't drop players.
const RESYNC_INTERVAL_MS = 5 * 60_000;

interface ServerMap {
  name: string;
  size: number;
  sha256: string;
}

const cacheKey = (map: ServerMap) => `${CACHE_PREFIX}${map.name}:${map.sha256}`;

// Names from the last successful listing, sorted by the server.
let serverMaps: string[] = [];
let syncing: Promise<void> | undefined;
let resyncTimer: ReturnType<typeof setInterval> | undefined;

/** Maps the server listed during syncServerMaps, for the admin menu. */
export function getServerMaps(): readonly string[] {
  return serverMaps;
}

/**
 * Makes every map the server lists available to the engine. Not fatal: a
 * map that can't be fetched only matters if the server switches to it.
 * Joins a sync that is already running instead of starting another.
 */
export function syncServerMaps(engine: Xash3D): Promise<void> {
  syncing ??= syncMaps(engine).finally(() => {
    syncing = undefined;
  });
  return syncing;
}

/** Re-syncs the server's maps periodically while a game is running. */
export function startMapResync(engine: Xash3D): void {
  stopMapResync();
  resyncTimer = setInterval(() => {
    void syncServerMaps(engine);
  }, RESYNC_INTERVAL_MS);
}

export function stopMapResync(): void {
  clearInterval(resyncTimer);
  resyncTimer = undefined;
}

async function syncMaps(engine: Xash3D): Promise<void> {
  let maps: ServerMap[];
  try {
    const response = await fetch(`${MAPS_URL}index.json`, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    maps = await response.json();
  } catch (error) {
    console.warn('Failed to list server maps:', error);
    return;
  }
  serverMaps = maps.map((map) => map.name);

  const missing = maps.filter((map) => !hasMap(engine, map));
  await deleteStaleMaps(maps);
  if (missing.length === 0) return;

  engine.em.FS.mkdirTree(MAPS_DIR);
  let done = 0;
  for (const map of missing) {
    updateProgress('load', done / missing.length, `Downloading ${map.name}...`);
    try {
      engine.em.FS.writeFile(`${MAPS_DIR}/${map.name}.bsp`, await fetchMap(map));
    } catch (error) {
      console.warn(`Failed to download map ${map.name}:`, error);
    }
    done += 1;
  }
  updateProgress('load', 1, 'Done');
}

// Maps already in the game zip are identical when the sizes match; both
// sides ship the same HLDS build.
function hasMap(engine: Xash3D, map: ServerMap): boolean {
  try {
    return engine.em.FS.stat(`${MAPS_DIR}/${map.name}.bsp`).size === map.size;
  } catch {
    return false;
  }
}

async function fetchMap(map: ServerMap): Promise<Uint8Array> {
  const key = cacheKey(map);
  try {
    const cached = await get<ArrayBuffer>(key);
    if (cached) return new Uint8Array(cached);
  } catch {}

  const response = await fetch(`${MAPS_URL}${encodeURIComponent(map.name)}.bsp`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.arrayBuffer();
  if (data.byteLength !== map.size) {
    throw new Error(`Expected ${map.size} bytes, got ${data.byteLength}`);
  }
  if (!(await matchesHash(data, map.sha256))) {
    throw new Error('SHA-256 does not match the server listing');
  }
  try {
    await set(key, data);
  } catch (error) {
    // Not fatal: the map is in memory, it just won't be cached.
    console.warn(`Failed to cache map ${map.name}:`, error);
  }
  return new Uint8Array(data);
}

// crypto.subtle only exists in secure contexts (HTTPS or localhost); over
// plain HTTP the size check above is all there is. Cached maps were checked
// when stored: the cache key includes the hash.
async function matchesHash(data: ArrayBuffer, sha256: string): Promise<boolean> {
  if (!globalThis.crypto?.subtle) return true;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const hex = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  return hex === sha256.toLowerCase();
}

// Drops cached maps the server no longer has, or has replaced.
async function deleteStaleMaps(maps: ServerMap[]): Promise<void> {
  const current = new Set(maps.map(cacheKey));
  try {
    const stale = (await keys()).filter(
      (key) =>
        typeof key === 'string' &&
        key.startsWith(CACHE_PREFIX) &&
        !current.has(key)
    );
    if (stale.length > 0) {
      await delMany(stale);
    }
  } catch (error) {
    console.warn('Failed to delete stale maps cache:', error);
  }
}
