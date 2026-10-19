// Truevision TGA decoder for the buy menu's pictures (cstrike/gfx/vgui/*.tga
// in the game files: 32-bit, uncompressed, which browsers can't show). Also
// reads 24-bit and run-length encoded files. No DOM here.

export type DecodedImage = {
  width: number;
  height: number;
  /** RGBA, rows from the top, as ImageData wants it. */
  data: Uint8ClampedArray<ArrayBuffer>;
};

const HEADER_SIZE = 18;
const TRUE_COLOR = 2;
const TRUE_COLOR_RLE = 10;
// Image descriptor bit: rows are stored from the top (else from the bottom).
const TOP_ORIGIN = 0x20;

/** Throws on anything but true-colour 24 / 32-bit images or a short file. */
export function decodeTga(file: Uint8Array): DecodedImage {
  if (file.length < HEADER_SIZE) throw new Error('TGA: file too short');
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const idLength = file[0];
  const colorMapType = file[1];
  const imageType = file[2];
  const colorMapLength = view.getUint16(5, true);
  const colorMapEntryBits = file[7];
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const bits = file[16];
  const descriptor = file[17];

  if (imageType !== TRUE_COLOR && imageType !== TRUE_COLOR_RLE) {
    throw new Error(`TGA: unsupported image type ${imageType}`);
  }
  if (bits !== 24 && bits !== 32) throw new Error(`TGA: ${bits}-bit pixels`);
  if (width === 0 || height === 0) throw new Error('TGA: empty image');

  const bytesPerPixel = bits / 8;
  let offset =
    HEADER_SIZE +
    idLength +
    (colorMapType ? colorMapLength * Math.ceil(colorMapEntryBits / 8) : 0);
  const pixels = width * height;
  // Pixels in file order (BGR(A)), unpacked from runs if needed.
  const raw = new Uint8Array(pixels * bytesPerPixel);

  if (imageType === TRUE_COLOR) {
    if (offset + raw.length > file.length) throw new Error('TGA: truncated');
    raw.set(file.subarray(offset, offset + raw.length));
  } else {
    let pixel = 0;
    while (pixel < pixels) {
      if (offset >= file.length) throw new Error('TGA: truncated');
      const packet = file[offset++];
      const count = Math.min((packet & 0x7f) + 1, pixels - pixel);
      if (packet & 0x80) {
        if (offset + bytesPerPixel > file.length) {
          throw new Error('TGA: truncated');
        }
        const value = file.subarray(offset, offset + bytesPerPixel);
        offset += bytesPerPixel;
        for (let i = 0; i < count; i++) {
          raw.set(value, (pixel + i) * bytesPerPixel);
        }
      } else {
        const length = count * bytesPerPixel;
        if (offset + length > file.length) throw new Error('TGA: truncated');
        raw.set(file.subarray(offset, offset + length), pixel * bytesPerPixel);
        offset += length;
      }
      pixel += count;
    }
  }

  const data = new Uint8ClampedArray(pixels * 4);
  const fromTop = (descriptor & TOP_ORIGIN) !== 0;
  for (let y = 0; y < height; y++) {
    const row = fromTop ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const src = (row * width + x) * bytesPerPixel;
      const dst = (y * width + x) * 4;
      data[dst] = raw[src + 2];
      data[dst + 1] = raw[src + 1];
      data[dst + 2] = raw[src];
      data[dst + 3] = bytesPerPixel === 4 ? raw[src + 3] : 255;
    }
  }
  return { width, height, data };
}
