import { z } from 'zod';
import { CONTACT_DETAILS_MESSAGE, findContactDetails } from '../../../platform/text/contact-details.ts';
import { PARTICIPATION_STATUSES } from '../domain/participation.ts';

const point = z.object({ latitude: z.number(), longitude: z.number() });

export const propertyInputShape = {
  address: z.string().trim().min(5).max(300),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  // Shown publicly: locality only (L-4), so no contact details or house numbers.
  areaLabel: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .refine((v) => findContactDetails(v) === null, CONTACT_DETAILS_MESSAGE)
    .refine((v) => !/\d{2,}/.test(v), 'Use the locality name only (no house or flat numbers)'),
  timezone: z.string().max(64).default('Asia/Kolkata'),
};

export const hostPropertySchema = z.object({
  id: z.uuid(),
  kind: z.enum(['APARTMENT_SOCIETY', 'INDEPENDENT_HOUSE', 'COMMERCIAL', 'OFFICE', 'OTHER']),
  displayName: z.string().nullable(),
  relation: z.enum(['OWNER', 'MEMBER_HOST']),
  address: z.string(),
  exactPoint: point,
  publicPoint: point,
  areaLabel: z.string(),
  timezone: z.string(),
  participationStatus: z.enum(PARTICIPATION_STATUSES),
  version: z.number().int(),
  createdAt: z.date(),
});

export const adminPropertySchema = hostPropertySchema.omit({ relation: true }).extend({
  outsiderCap: z.number().int().nullable(),
  memberHosts: z.array(z.object({ hostAccountId: z.uuid(), status: z.enum(['ACTIVE', 'REVOKED']) })),
});
