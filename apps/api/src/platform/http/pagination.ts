import { z } from 'zod';

/** Admin list pagination (offset-based; admin datasets are small and filters narrow them). */
export const pageQuery = {
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
};

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    offset: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
  });

export interface Page<T> {
  items: T[];
  offset: number;
  limit: number;
  total: number;
}
