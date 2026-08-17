/**
 * @lpr/ui — shared primitives and design tokens for both frontends.
 *
 * This package exists so that splitting the participant PWA and the researcher
 * dashboard into two applications (ADR-009) does not duplicate the design
 * system. It is consumed as source via Next's transpilePackages.
 *
 * Phase 0 scope: design tokens only. Components arrive with the screens that
 * need them, from Phase 2 onward. Building a speculative component library
 * before there are screens produces components nobody uses.
 */

export * from "./tokens.js";
