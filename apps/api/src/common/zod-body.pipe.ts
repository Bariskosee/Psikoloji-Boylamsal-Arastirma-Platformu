import { Injectable, PipeTransform } from "@nestjs/common";
import type { ZodSchema } from "zod";
import { ApiErrors } from "./api-error.js";

/**
 * Validates a request payload against a schema from @lpr/contracts.
 *
 * The same schema the frontend uses for its form, so client and server cannot
 * drift (ADR-001). Validation failures become `VALIDATION_FAILED` with
 * field-level paths, which is what lets a form highlight the offending input
 * rather than showing a generic banner.
 *
 * Parsing also NORMALISES — emails are lowercased and strings trimmed by the
 * schema — so every downstream service receives canonical values and nothing
 * has to remember to normalise them again.
 */
@Injectable()
export class ZodBodyPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw ApiErrors.validationFailed(
      result.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    );
  }
}

/** The same, for query strings and path parameters. */
export function zodPipe<T>(schema: ZodSchema<T>): ZodBodyPipe<T> {
  return new ZodBodyPipe(schema);
}
