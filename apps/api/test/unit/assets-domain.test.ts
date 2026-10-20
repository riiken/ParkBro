import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { publishChecklist, type ChecklistSnapshot } from '../../src/modules/assets/domain/checklist.ts';
import {
  ASSET_STATUSES,
  transition,
  type AssetAction,
  type AssetStatus,
} from '../../src/modules/assets/domain/state-machine.ts';
import {
  differenceHash,
  hammingDistance,
  processListingPhoto,
} from '../../src/modules/assets/infrastructure/images.ts';
import { jpegWithGps, png } from '../integration/helpers/images.ts';

describe('asset state machine (domain-model §5.1)', () => {
  const expected: Record<AssetAction, Partial<Record<AssetStatus, AssetStatus>>> = {
    SUBMIT: { DRAFT: 'PENDING_REVIEW' },
    APPROVE: { PENDING_REVIEW: 'PUBLISHED' },
    REJECT: { PENDING_REVIEW: 'DRAFT' },
    PAUSE: { PUBLISHED: 'PAUSED' },
    REPUBLISH: { PAUSED: 'PUBLISHED' },
    MATERIAL_CHANGE: {
      DRAFT: 'DRAFT',
      PENDING_REVIEW: 'PENDING_REVIEW',
      PUBLISHED: 'PENDING_REVIEW',
      PAUSED: 'PAUSED',
      SUSPENDED: 'SUSPENDED',
    },
    SUSPEND: { DRAFT: 'SUSPENDED', PENDING_REVIEW: 'SUSPENDED', PUBLISHED: 'SUSPENDED', PAUSED: 'SUSPENDED' },
    REINSTATE: { SUSPENDED: 'PAUSED' },
    ARCHIVE: { DRAFT: 'ARCHIVED', PAUSED: 'ARCHIVED' },
  };

  for (const [action, table] of Object.entries(expected) as [
    AssetAction,
    Partial<Record<AssetStatus, AssetStatus>>,
  ][]) {
    for (const from of ASSET_STATUSES) {
      const to = table[from];
      it(`${action} from ${from} → ${to ?? 'rejected'}`, () => {
        expect(transition(from, action, { needsReview: false })?.to ?? null).toBe(to ?? null);
      });
    }
  }

  it('a material change while paused makes the next republish go to review', () => {
    const paused = transition('PAUSED', 'MATERIAL_CHANGE', { needsReview: false });
    expect(paused).toEqual({ to: 'PAUSED', needsReview: true });
    expect(transition('PAUSED', 'REPUBLISH', { needsReview: true })).toEqual({
      to: 'PENDING_REVIEW',
      needsReview: false,
    });
  });

  it('archived listings accept no further transitions', () => {
    for (const action of Object.keys(expected) as AssetAction[]) {
      expect(transition('ARCHIVED', action, { needsReview: false })).toBeNull();
    }
  });
});

describe('publish checklist', () => {
  const complete: ChecklistSnapshot = {
    assetType: 'EV_CHARGING',
    requiredMediaKinds: ['SLOT', 'CHARGER'],
    requiredAttestations: ['RIGHT_TO_RENT', 'CHARGER_SAFETY'],
    hasParkingDetails: true,
    hasChargerDetails: true,
    activeUnits: 1,
    mediaKinds: ['SLOT', 'CHARGER'],
    rateModes: ['CHARGING_SESSION'],
    availabilityRules: 1,
    attestationStatuses: { RIGHT_TO_RENT: 'ATTESTED', CHARGER_SAFETY: 'VERIFIED' },
    listing: { canPublish: true },
    hostActive: true,
  };

  it('is ready when everything is present', () =>
    expect(publishChecklist(complete)).toEqual({ ready: true, missing: [] }));

  it('lists every missing item', () => {
    const result = publishChecklist({
      ...complete,
      hasParkingDetails: false,
      hasChargerDetails: false,
      activeUnits: 0,
      mediaKinds: ['OTHER'],
      rateModes: [],
      availabilityRules: 0,
      attestationStatuses: { RIGHT_TO_RENT: 'REJECTED' },
      listing: { canPublish: false },
      hostActive: false,
    });
    expect(result.missing).toEqual([
      'PARKING_DETAILS',
      'CHARGER_DETAILS',
      'UNITS',
      'PHOTO_SLOT',
      'PHOTO_CHARGER',
      'RATE',
      'AVAILABILITY',
      'ATTESTATION_RIGHT_TO_RENT',
      'ATTESTATION_CHARGER_SAFETY',
      'SOCIETY_NOT_PARTICIPATING',
      'HOST_NOT_ACTIVE',
    ]);
  });

  it('flags a host no longer linked to the property', () => {
    expect(publishChecklist({ ...complete, listing: null }).missing).toEqual(['NOT_A_MEMBER']);
  });
});

describe('listing photo pipeline', () => {
  it('re-encodes to WebP and strips EXIF including GPS', async () => {
    const input = await jpegWithGps();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const out = await processListingPhoto(input);
    const meta = await sharp(out.data).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(out.data.includes(Buffer.from('TestPhone'))).toBe(false);
  });

  it('caps the long edge at 2048 px', async () => {
    const out = await processListingPhoto(await png(3000, 1000));
    expect([out.width, out.height]).toEqual([2048, 683]);
  });

  it('rejects non-images, disguised files and tiny images', async () => {
    await expect(
      processListingPhoto(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).rejects.toMatchObject({
      code: 'media.unsupported',
    });
    await expect(processListingPhoto(Buffer.from('GIF89a not really'))).rejects.toMatchObject({
      code: 'media.unsupported',
    });
    await expect(processListingPhoto(await png(200, 150))).rejects.toMatchObject({ code: 'media.too_small' });
  });

  it('perceptual hash: near-identical for a resized/recompressed copy, far for a different photo', async () => {
    const original = await processListingPhoto(await png(1200, 900, 5));
    const recompressed = await sharp(original.data).resize(700).jpeg({ quality: 60 }).toBuffer();
    const different = await processListingPhoto(await png(1200, 900, 42));
    expect(hammingDistance(original.phash, await differenceHash(recompressed))).toBeLessThanOrEqual(6);
    expect(hammingDistance(original.phash, different.phash)).toBeGreaterThan(10);
  });
});
