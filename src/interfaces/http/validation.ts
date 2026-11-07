import { type z } from 'zod';
import { InvalidRequestError } from '../../application/errors';

/** Parses untrusted input with a zod schema, failing with every issue listed at once. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new InvalidRequestError(
    'Request does not match the expected contract',
    result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.') || '(root)',
      message: issue.message,
    })),
  );
}
