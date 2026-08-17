/**
 * Design tokens shared by both frontends.
 *
 * Touch targets follow NFR-15: participants answer questionnaires on phones,
 * repeatedly, for weeks. 44px is the practical minimum for a comfortable tap.
 */
export const tokens = {
  touchTargetMinPx: 44,
  contentMaxWidthPx: 640,
  radiusPx: 8,
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 40 },
} as const;

export type Tokens = typeof tokens;
