import sharp from 'sharp';

/** A real JPEG with EXIF including GPS coordinates (to prove the upload pipeline strips them). */
export async function jpegWithGps(
  options: { width?: number; height?: number; seed?: number } = {},
): Promise<Buffer> {
  const { width = 800, height = 600, seed = 1 } = options;
  return sharp(noise(width, height, seed), { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .withMetadata({
      exif: {
        IFD0: { Make: 'TestPhone', Model: 'Camera' },
        IFD3: {
          GPSLatitudeRef: 'N',
          GPSLatitude: '12/1 56/1 7/1',
          GPSLongitudeRef: 'E',
          GPSLongitude: '77/1 37/1 28/1',
        },
      },
    })
    .toBuffer();
}

export async function png(width = 800, height = 600, seed = 2): Promise<Buffer> {
  return sharp(noise(width, height, seed), { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/**
 * Deterministic synthetic photo: a coarse grid of seed-dependent brightness blocks (the low-frequency structure a
 * perceptual hash sees) plus fine noise (which it should ignore). Different seeds → different scenes.
 */
function noise(width: number, height: number, seed: number): Buffer {
  let x = (seed * 2654435761) >>> 0;
  const next = () => {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    return x / 0xffffffff;
  };
  const grid = Array.from({ length: 6 * 6 }, () => Math.floor(next() * 255));
  const data = Buffer.alloc(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    const col = p % width;
    const row = Math.floor(p / width);
    const block = grid[Math.floor((row * 6) / height) * 6 + Math.floor((col * 6) / width)] ?? 0;
    const grain = Math.floor(next() * 16);
    data[p * 3] = Math.min(255, block + grain);
    data[p * 3 + 1] = Math.min(255, (block * 3) % 256);
    data[p * 3 + 2] = Math.min(255, 255 - block + grain);
  }
  return data;
}
