import { Platform, useColorScheme } from 'react-native';

/**
 * Shared design system (Section 14a). One set of tokens for both platforms; platform-specific
 * touches (haptics, ripples, sheets) live in the components.
 *
 * Look: deep green for trust, marigold reserved for "needs your attention now", warm off-white
 * ground. Bricolage Grotesque for headings and amounts, Figtree for everything else.
 */
const palette = {
  green950: '#0A2E24',
  green800: '#0A4434',
  green700: '#0F5C45',
  green600: '#1C6E56',
  green400: '#3FB27F',
  green200: '#CFE3DA',
  green100: '#E3F0E9',
  marigold500: '#F2B544',
  marigold600: '#E8901C',
  marigold100: '#FDF1DA',
  marigoldInk: '#7A4A00',
  red700: '#A3321F',
  red100: '#FBE3DD',
  ink: '#17211C',
  ink2: '#2E3A34',
  gray600: '#55615B',
  gray400: '#9AA59F',
  gray300: '#C9CFC5',
  gray200: '#DDE1D8',
  gray150: '#E6E8E1',
  ground: '#F3F4EF',
  white: '#FFFFFF',
  night950: '#0E1412',
  night900: '#161E1A',
  night800: '#202A25',
  night700: '#2A352F',
};

/**
 * Font families are registered under our own aliases in app/_layout.tsx. If the font files fail to
 * load, `applyFonts(false)` switches every alias back to the system font so text still renders.
 */
const FAMILIES = {
  display: 'HW-Display-ExtraBold',
  displayBold: 'HW-Display-Bold',
  body: 'HW-Body-Regular',
  bodyMedium: 'HW-Body-Medium',
  bodySemibold: 'HW-Body-SemiBold',
  bodyBold: 'HW-Body-Bold',
} as const;
type FamilyKey = keyof typeof FAMILIES;
let fontsLoaded = false;

export type Theme = ReturnType<typeof makeTheme>;

function makeTheme(dark: boolean) {
  // With custom fonts the weight lives in the family (Android ignores fontWeight on custom fonts);
  // without them we fall back to the system font plus a weight.
  const f = (key: FamilyKey, size: number, weight: '400' | '500' | '600' | '700' | '800', extra: object = {}) =>
    fontsLoaded ? { fontFamily: FAMILIES[key], fontSize: size, ...extra } : { fontSize: size, fontWeight: weight, ...extra };

  return {
    dark,
    color: {
      bg: dark ? palette.night950 : palette.ground,
      surface: dark ? palette.night900 : palette.white,
      surfaceAlt: dark ? palette.night800 : palette.gray150,
      text: dark ? '#ECEFEA' : palette.ink,
      textSoft: dark ? '#C8D0CB' : palette.ink2,
      textMuted: dark ? palette.gray400 : palette.gray600,
      border: dark ? palette.night700 : palette.gray200,
      borderStrong: dark ? '#3A463F' : palette.gray300,
      primary: dark ? palette.green400 : palette.green700,
      primaryFill: dark ? '#1E8A63' : palette.green700, // solid button fill (white text on it)
      primaryText: palette.white,
      primarySoft: dark ? '#173A2E' : palette.green100,
      // Hero surfaces (profile header, escrow card) stay green in both modes.
      hero: palette.green700,
      heroRaised: palette.green600,
      heroText: palette.white,
      heroMuted: palette.green200,
      accent: palette.marigold500,
      star: palette.marigold600,
      accentSoft: dark ? '#3A2F10' : palette.marigold100,
      accentInk: dark ? palette.marigold500 : palette.marigoldInk,
      danger: dark ? '#E0705C' : palette.red700,
      dangerSoft: dark ? '#3A1C17' : palette.red100,
      link: dark ? palette.green400 : palette.green700,
      ink: palette.ink, // dark header band on the technician home
      inkRaised: '#26322C',
      inkMuted: '#B9C4BE',
      online: palette.green400,
      // Labels for paid placement must stay honest and quiet (Section 14).
      promoted: dark ? palette.marigold500 : '#8A5300',
      sponsoredBg: dark ? '#26221A' : '#FFF8E6',
    },
    space: (n: number) => n * 4,
    radius: { sm: 12, md: 16, lg: 20, xl: 24, pill: 999 },
    font: {
      display: f('display', 30, '800', { lineHeight: 34, letterSpacing: -0.5 }),
      title: f('display', 22, '800', { lineHeight: 28 }),
      heading: f('displayBold', 17, '700', { lineHeight: 22 }),
      body: f('body', 15, '400', { lineHeight: 21 }),
      bodyStrong: f('bodyBold', 15, '700', { lineHeight: 21 }),
      small: f('body', 13, '400', { lineHeight: 18 }),
      smallStrong: f('bodyBold', 13, '700', { lineHeight: 18 }),
      tiny: f('bodySemibold', 12, '600', { lineHeight: 16 }),
      label: f('bodyBold', 12, '700', { lineHeight: 16, letterSpacing: 0.6, textTransform: 'uppercase' as const }),
      button: f('bodyBold', 16, '700'),
      amount: f('display', 34, '800', { letterSpacing: -0.5 }),
      money: { fontVariant: ['tabular-nums' as const] },
    },
    shadow: Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: dark ? 0 : 0.04, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
      default: { elevation: 0 },
    })!,
  };
}

let lightTheme = makeTheme(false);
let darkTheme = makeTheme(true);

/** Called once from the root layout after the font files load (or fail to). */
export function applyFonts(loaded: boolean) {
  fontsLoaded = loaded;
  lightTheme = makeTheme(false);
  darkTheme = makeTheme(true);
}

export const FONT_ALIASES = FAMILIES;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? darkTheme : lightTheme;
}
