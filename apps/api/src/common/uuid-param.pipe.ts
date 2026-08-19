import { Injectable, PipeTransform } from "@nestjs/common";
import type { ApiException } from "./api-error.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rejects a path parameter that is not a UUID, with the SAME error the route
 * returns for a well-formed id that does not exist.
 *
 * Two reasons it is not a generic 400:
 *
 * 1. A malformed uuid compared against a `uuid` column raises a PostgreSQL
 *    type error, which surfaces as an opaque 500 and logs a query fragment.
 *    Stopping it at the boundary keeps a fuzzed request from looking like an
 *    outage.
 * 2. "Malformed" and "not found" must be indistinguishable to the caller, for
 *    the same reason `StudyPermissionGuard` collapses forbidden into not
 *    found — a different response for a syntactically valid id is a free
 *    existence oracle.
 */
@Injectable()
export class UuidParamPipe implements PipeTransform<unknown, string> {
  constructor(private readonly notFound: () => ApiException) {}

  transform(value: unknown): string {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw this.notFound();
    return value;
  }
}

export function uuidParam(notFound: () => ApiException): UuidParamPipe {
  return new UuidParamPipe(notFound);
}
