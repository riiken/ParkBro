import { z } from 'zod';

/**
 * RFC 9457 problem details, as returned by every API error (architecture.md §6.6, D-035).
 * `code` is the stable, machine-readable identifier clients branch on; `detail` is user-safe text.
 */
export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  requestId: z.string(),
  errors: z
    .array(
      z.object({
        path: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
