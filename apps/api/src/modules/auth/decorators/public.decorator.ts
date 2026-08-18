import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "lpr:isPublic";

/**
 * Marks a route as reachable without a session.
 *
 * Authentication is GLOBAL and opt-out rather than opt-in. A new controller
 * added in Phase 6 is protected by default; forgetting a guard cannot silently
 * publish participant data, whereas forgetting this decorator merely produces
 * a 401 that shows up on the first test run.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
