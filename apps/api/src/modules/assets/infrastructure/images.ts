import { createHash } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';
import { DomainError } from '../../../platform/errors/domain-error.ts';

/**
 * Listing photo pipeline (trust-and-safety §6, L-5): decode (rejects non-images and polyglots), apply EXIF
 * orientation, cap size, re-encode to WebP. Re-encoding drops ALL metadata, including GPS coordinates that would
 * reveal a home's exact location. Also computes a 64-bit difference hash for near-duplicate detection.
 */
export const ACCEPTED_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp']);
const MIN_WIDTH = 400;
const MIN_HEIGHT = 300;
const MAX_EDGE = 2048;

export interface ProcessedImage {
  data: Buffer;
  width: number;
  height: number;
  sha256: Buffer;
  /** Signed 64-bit dHash as a decimal string (Postgres bigint). */
  phash: string;
}

export const imageErrors = {
  unsupported: () =>
    new DomainError({
      code: 'media.unsupported',
      status: 415,
      title: 'Unsupported image',
      detail: 'Upload a JPEG, PNG or WebP photo.',
    }),
  tooSmall: () =>
    new DomainError({
      code: 'media.too_small',
      status: 400,
      title: 'Photo is too small',
      detail: `Use a photo at least ${MIN_WIDTH}×${MIN_HEIGHT} pixels.`,
    }),
};

export async function processListingPhoto(input: Buffer): Promise<ProcessedImage> {
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: 40_000_000, failOn: 'error' }).metadata();
  } catch {
    throw imageErrors.unsupported();
  }
  if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) throw imageErrors.unsupported();

  const { data, info } = await sharp(input, { limitInputPixels: 40_000_000, failOn: 'error' })
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
  if (info.width < MIN_WIDTH || info.height < MIN_HEIGHT) throw imageErrors.tooSmall();

  return {
    data,
    width: info.width,
    height: info.height,
    sha256: createHash('sha256').update(data).digest(),
    phash: await differenceHash(data),
  };
}

/** dHash: 9×8 greyscale, each bit = left pixel brighter than right. Robust to resizing and re-compression. */
export async function differenceHash(image: Buffer): Promise<string> {
  const pixels = await sharp(image).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let hash = 0n;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = pixels[row * 9 + col] ?? 0;
      const right = pixels[row * 9 + col + 1] ?? 0;
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }
  return BigInt.asIntN(64, hash).toString();
}

export function hammingDistance(a: string, b: string): number {
  let x = BigInt.asUintN(64, BigInt(a) ^ BigInt(b));
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}
