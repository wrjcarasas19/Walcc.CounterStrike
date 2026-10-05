import { loadAsync } from 'jszip';
import { get, set } from 'idb-keyval';
import { updateProgress } from './desktop';

const FILE_KEY = 'gamefiles.zip';
const GAMEFILES_URL =
  'https://sgwalcc.blob.core.windows.net/public/gamezip_8308.zip';
// Used when the response has no Content-Length.
const FALLBACK_BYTES = 483 * 1024 * 1024;

export async function getGameFiles() {
  const cacheHit = await get<ArrayBuffer>(FILE_KEY);
  if (cacheHit) {
    updateProgress('download', 1, 'Using cached game files');
    return loadAsync(cacheHit);
  }
  updateProgress('download', 0, 'Connecting...');
  const response = await fetch(GAMEFILES_URL);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch game files (${response.status})`);
  }

  const advertised = Number(response.headers.get('Content-Length'));
  const expected =
    Number.isFinite(advertised) && advertised > 0 ? advertised : FALLBACK_BYTES;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    const total = Math.max(expected, received);
    updateProgress(
      'download',
      received / total,
      `${formatMegabytes(received)} / ${formatMegabytes(total)} MB`
    );
  }

  updateProgress('download', 1, 'Done');

  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  await set(FILE_KEY, buffer.buffer);
  return loadAsync(buffer.buffer);
}

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
