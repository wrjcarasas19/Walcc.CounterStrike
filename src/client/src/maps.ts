import { delMany, get, keys, set } from 'idb-keyval';
import type { Xash3D } from 'xash3d-fwgs';
import { updateProgress } from './desktop';

// Maps the server has but the game zip lacks are fetched over HTTP and
// written into the engine's filesystem before connecting, with the files
// their .res lists (models, sounds, skies). The engine's own download stays
// off (cl_allowdownload 0): it crashes this dedicated server.
const MAPS_URL = '/maps/';
const FILES_URL = '/maps/files/';
const GAME_DIR = '/rodir/cstrike';
const MAPS_DIR = `${GAME_DIR}/maps`;
const CACHE_PREFIX = 'map:';
const RESOURCE_CACHE_PREFIX = 'res:';
// While in game, maps added to the server since the page loaded are fetched
// in the background, so a later changelevel to them doesn't drop players.
const RESYNC_INTERVAL_MS = 5 * 60_000;

interface ServerMap {
  name: string;
  size: number;
  sha256: string;
  resources?: ServerResource[];
}

interface ServerResource {
  // Relative to the game directory, e.g. models/x.mdl.
  path: string;
  size: number;
  sha256: string;
}

// A file to put in the engine's filesystem: a map's .bsp or a resource.
interface ServerFile {
  label: string;
  fsPath: string;
  url: string;
  size: number;
  sha256: string;
  cacheKey: string;
}

function serverFiles(maps: ServerMap[]): ServerFile[] {
  const files = new Map<string, ServerFile>();
  for (const map of maps) {
    files.set(`maps/${map.name}.bsp`, {
      label: map.name,
      fsPath: `${MAPS_DIR}/${map.name}.bsp`,
      url: `${MAPS_URL}${encodeURIComponent(map.name)}.bsp`,
      size: map.size,
      sha256: map.sha256,
      cacheKey: `${CACHE_PREFIX}${map.name}:${map.sha256}`,
    });
    for (const resource of map.resources ?? []) {
      files.set(resource.path, {
        label: `${map.name} (${resource.path})`,
        fsPath: `${GAME_DIR}/${resource.path}`,
        url: `${FILES_URL}${resource.path.split('/').map(encodeURIComponent).join('/')}`,
        size: resource.size,
        sha256: resource.sha256,
        cacheKey: `${RESOURCE_CACHE_PREFIX}${resource.path}:${resource.sha256}`,
      });
    }
  }
  return [...files.values()];
}

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
    const response = await fetch(`${MAPS_URL}index.json`, {
      cache: 'no-cache',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    maps = await response.json();
  } catch (error) {
    console.warn('Failed to list server maps:', error);
    return;
  }
  serverMaps = maps.map((map) => map.name);

  const files = serverFiles(maps);
  const missing = files.filter((file) => !hasFile(engine, file));
  await deleteStaleFiles(files);
  if (missing.length === 0) return;

  let done = 0;
  for (const file of missing) {
    updateProgress(
      'load',
      done / missing.length,
      `Downloading ${file.label}...`,
    );
    try {
      const data = await fetchFile(file);
      engine.em.FS.mkdirTree(
        file.fsPath.slice(0, file.fsPath.lastIndexOf('/')),
      );
      engine.em.FS.writeFile(file.fsPath, data);
    } catch (error) {
      console.warn(`Failed to download ${file.label}:`, error);
    }
    done += 1;
  }
  updateProgress('load', 1, 'Done');
}

// Files already in the game zip are identical when the sizes match; both
// sides ship the same HLDS build.
function hasFile(engine: Xash3D, file: ServerFile): boolean {
  try {
    return engine.em.FS.stat(file.fsPath).size === file.size;
  } catch {
    return false;
  }
}

async function fetchFile(file: ServerFile): Promise<Uint8Array> {
  try {
    const cached = await get<ArrayBuffer>(file.cacheKey);
    if (cached) return new Uint8Array(cached);
  } catch {}

  const response = await fetch(file.url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.arrayBuffer();
  if (data.byteLength !== file.size) {
    throw new Error(`Expected ${file.size} bytes, got ${data.byteLength}`);
  }
  if (!(await matchesHash(data, file.sha256))) {
    throw new Error('SHA-256 does not match the server listing');
  }
  try {
    await set(file.cacheKey, data);
  } catch (error) {
    // Not fatal: the file is in memory, it just won't be cached.
    console.warn(`Failed to cache ${file.label}:`, error);
  }
  return new Uint8Array(data);
}

// crypto.subtle only exists in secure contexts (HTTPS or localhost); over
// plain HTTP the size check above is all there is. Cached maps were checked
// when stored: the cache key includes the hash.
async function matchesHash(
  data: ArrayBuffer,
  sha256: string,
): Promise<boolean> {
  if (!globalThis.crypto?.subtle) return true;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const hex = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return hex === sha256.toLowerCase();
}

// Drops cached files the server no longer has, or has replaced.
async function deleteStaleFiles(files: ServerFile[]): Promise<void> {
  const current = new Set(files.map((file) => file.cacheKey));
  try {
    const stale = (await keys()).filter(
      (key) =>
        typeof key === 'string' &&
        (key.startsWith(CACHE_PREFIX) ||
          key.startsWith(RESOURCE_CACHE_PREFIX)) &&
        !current.has(key),
    );
    if (stale.length > 0) {
      await delMany(stale);
    }
  } catch (error) {
    console.warn('Failed to delete stale maps cache:', error);
  }
}
