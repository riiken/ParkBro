import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { DomainError } from '../../../platform/errors/domain-error.ts';

export const EVIDENCE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const MAX_EDGE = 2048;

/**
 * Evidence photos: decoded and re-encoded to WebP (rejects non-images; drops all metadata incl. GPS), auto-rotated,
 * capped at 2048 px. Small photos are fine (unlike listing photos): a scratch close-up can be small.
 */
export async function processEvidence(input: Buffer) {
  try {
    const meta = await sharp(input, { failOn: 'error' }).metadata();
    if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) throw new Error('format');
    const out = await sharp(input, { failOn: 'error' })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return {
      data: out.data,
      width: out.info.width,
      height: out.info.height,
      sha256: createHash('sha256').update(out.data).digest(),
    };
  } catch {
    throw new DomainError({
      code: 'evidence.unsupported',
      status: 415,
      title: 'Upload a JPEG, PNG or WebP photo',
    });
  }
}
