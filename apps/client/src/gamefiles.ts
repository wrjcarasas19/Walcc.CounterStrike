import { loadAsync } from 'jszip';
import { delMany, get, keys, set } from 'idb-keyval';
import { updateProgress } from './desktop';

// The cache is keyed by the URL, so publishing a new zip under a new URL
// makes returning players download it.
const GAMEFILES_URL =
  'https://sgwalcc.blob.core.windows.net/public/gamezip_8308.zip';
// Key used before the cache was versioned.
const LEGACY_KEY = 'gamefiles.zip';
// Used when the response has no Content-Length.
const FALLBACK_BYTES = 483 * 1024 * 1024;

export class GameFilesError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GameFilesError';
    this.status = status;
  }
}

export async function getGameFiles() {
  const cacheHit = await get<ArrayBuffer>(GAMEFILES_URL);
  if (cacheHit) {
    updateProgress('download', 1, 'Using cached game files');
    return loadAsync(cacheHit);
  }
  await deleteStaleCaches();
  updateProgress('download', 0, 'Connecting...');
  let response: Response;
  try {
    response = await fetch(GAMEFILES_URL);
  } catch (error) {
    throw new GameFilesError(`Failed to fetch game files: ${error}`);
  }
  if (!response.ok || !response.body) {
    throw new GameFilesError(
      `Failed to fetch game files (${response.status})`,
      response.status
    );
  }

  const advertised = Number(response.headers.get('Content-Length'));
  const known = Number.isSafeInteger(advertised) && advertised > 0;
  const expected = known ? advertised : FALLBACK_BYTES;

  // With a known size the download is written into one buffer, so the zip
  // is held once instead of as chunks plus a concatenated copy.
  let buffer = known ? allocate(advertised) : undefined;
  let chunks: Uint8Array[] = [];
  let received = 0;

  const reader = response.body.getReader();
  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      throw new GameFilesError(`Game files download interrupted: ${error}`);
    }
    const { done, value } = chunk;
    if (done) break;
    if (buffer && received + value.byteLength > buffer.byteLength) {
      // Longer than advertised: collect the rest as chunks.
      chunks.push(buffer.subarray(0, received));
      buffer = undefined;
    }
    if (buffer) {
      buffer.set(value, received);
    } else {
      chunks.push(value);
    }
    received += value.byteLength;
    const total = Math.max(expected, received);
    updateProgress(
      'download',
      received / total,
      `${formatMegabytes(received)} / ${formatMegabytes(total)} MB`
    );
  }

  updateProgress('download', 1, 'Done');

  let data: ArrayBuffer;
  if (buffer) {
    // Trim a body shorter than advertised by copying; storing a view would
    // still store the whole buffer in IndexedDB.
    data =
      received === buffer.byteLength
        ? buffer.buffer
        : buffer.buffer.slice(0, received);
  } else {
    data = concat(chunks, received).buffer;
  }
  buffer = undefined;
  chunks = [];

  try {
    await set(GAMEFILES_URL, data);
  } catch (error) {
    // Not fatal: the files are in memory, they just won't be cached.
    console.warn('Failed to cache game files:', error);
  }
  return loadAsync(data);
}

// Returns undefined when the advertised size can't be allocated, so the
// download falls back to collecting chunks.
function allocate(bytes: number): Uint8Array<ArrayBuffer> | undefined {
  try {
    return new Uint8Array(bytes);
  } catch {
    return undefined;
  }
}

function concat(chunks: Uint8Array[], length: number): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

// Removes game-file zips cached under the legacy key or an older URL, so
// they don't pile up in IndexedDB. Unrelated keys are left alone.
async function deleteStaleCaches(): Promise<void> {
  try {
    const stale = (await keys()).filter(
      (key) =>
        key !== GAMEFILES_URL &&
        (key === LEGACY_KEY ||
          (typeof key === 'string' && /^https?:\/\/\S+\.zip$/i.test(key)))
    );
    if (stale.length > 0) {
      await delMany(stale);
    }
  } catch (error) {
    console.warn('Failed to delete stale game files cache:', error);
  }
}

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
