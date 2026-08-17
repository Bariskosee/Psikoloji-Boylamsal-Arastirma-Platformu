/**
 * Drizzle schema definitions.
 *
 * Phase 0 intentionally defines NO tables. The complete schema for both the
 * `research` and `identity` schemas — with every uniqueness constraint,
 * foreign key, enum check, and published-version immutability trigger — is
 * authored in Phase 1 as migration 0001.
 *
 * Writing tables here before Phase 1 would skip the review boundary that
 * exists precisely because this schema is where research integrity is won or
 * lost. See PLAN.md Phase 1.
 */

export {};
