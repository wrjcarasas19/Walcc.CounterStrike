import type { Xash3D } from 'xash3d-fwgs';
import { decodeTga } from './buy/tga';

// Where main.ts (loadGameFiles) unpacks the game files.
const PICTURE_DIR = '/rodir/cstrike/gfx/vgui';

/**
 * Reads cstrike/gfx/vgui/<name>.tga for each name from the engine's files
 * as PNG data URLs (the buy, team and character menus). A missing or broken
 * file is left out and named in one console warning, prefixed with `owner`.
 */
export function readVguiPictures(
  engine: Xash3D,
  names: readonly string[],
  owner: string
): Map<string, string> {
  const pictures = new Map<string, string>();
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return pictures;
  const failed: string[] = [];
  for (const name of names) {
    try {
      const image = decodeTga(
        engine.em.FS.readFile(`${PICTURE_DIR}/${name}.tga`)
      );
      canvas.width = image.width;
      canvas.height = image.height;
      context.putImageData(
        new ImageData(image.data, image.width, image.height),
        0,
        0
      );
      pictures.set(name, canvas.toDataURL('image/png'));
    } catch {
      failed.push(name);
    }
  }
  if (failed.length > 0) {
    console.warn(`${owner} pictures not loaded: ${failed.join(', ')}`);
  }
  return pictures;
}
