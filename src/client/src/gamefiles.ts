import { loadAsync } from 'jszip';
import { get, set } from 'idb-keyval';
import { updateProgress, updateStatus } from './desktop';

const FILE_KEY = 'gamefiles.zip';
// Used when the response has no Content-Length.
const FALLBACK_BYTES = 483 * 1024 * 1024;

export async function getGameFiles() {
  const cacheHit = await get<ArrayBuffer>(FILE_KEY);
  if (cacheHit) {
    updateStatus('Loading cached game files...');
    return loadAsync(cacheHit);
  }
  updateStatus('Fetching game files...');
  const response = await fetch(FILE_KEY);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch game files (${response.status})`);
  }

  const advertised = Number(response.headers.get('Content-Length'));
  const expected =
    Number.isFinite(advertised) && advertised > 0 ? advertised : FALLBACK_BYTES;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  updateProgress(0, expected);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    const total = Math.max(expected, received);
    updateProgress(received, total);
    updateStatus(
      `Fetching game files... (${formatMegabytes(received)} / ${formatMegabytes(total)} MB)`
    );
  }

  updateProgress(received, received);
  updateStatus(
    `Fetching game files... (${formatMegabytes(received)} / ${formatMegabytes(received)} MB)`
  );

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
