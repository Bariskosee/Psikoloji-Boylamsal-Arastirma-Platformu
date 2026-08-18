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

/**
 * Extensionless, unlike the backend packages.
 *
 * @lpr/ui is consumed as SOURCE through Next's `transpilePackages`, so webpack
 * resolves this specifier — and webpack under bundler resolution cannot map
 * `./tokens.js` onto `tokens.ts` the way `tsc` does for the CommonJS packages.
 * The `.js` form built cleanly only while nothing imported this package.
 */
export * from "./tokens";
