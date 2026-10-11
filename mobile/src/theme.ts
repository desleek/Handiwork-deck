import { Platform, useColorScheme } from 'react-native';

/**
 * Shared design system (Section 14a). Same tokens on both platforms, with platform-specific
 * motion, elevation and radii so each app feels native.
 */
const palette = {
  green900: '#0E3B2E',
  green700: '#17694F',
  green500: '#22A06B',
  green100: '#DDF4E8',
  amber500: '#F2A900',
  amber100: '#FFF3D1',
  red500: '#D64545',
  red100: '#FBE4E4',
  blue500: '#2F6FED',
  gray950: '#0F1115',
  gray900: '#16191F',
  gray800: '#23272F',
  gray600: '#5B6270',
  gray400: '#9AA1AD',
  gray200: '#E3E6EB',
  gray100: '#F2F4F7',
  white: '#FFFFFF',
};

export type Theme = ReturnType<typeof makeTheme>;

function makeTheme(dark: boolean) {
  return {
    dark,
    color: {
      bg: dark ? palette.gray950 : palette.gray100,
      surface: dark ? palette.gray900 : palette.white,
      surfaceAlt: dark ? palette.gray800 : palette.gray100,
      text: dark ? palette.gray100 : palette.gray950,
      textMuted: dark ? palette.gray400 : palette.gray600,
      border: dark ? palette.gray800 : palette.gray200,
      primary: dark ? palette.green500 : palette.green700,
      primaryText: palette.white,
      primarySoft: dark ? '#173A2E' : palette.green100,
      accent: palette.amber500,
      accentSoft: dark ? '#3A2F10' : palette.amber100,
      danger: palette.red500,
      dangerSoft: dark ? '#3A1C1C' : palette.red100,
      link: palette.blue500,
      // Labels for paid placement must stay honest and quiet (Section 14).
      promoted: dark ? palette.amber500 : '#8A6100',
      sponsoredBg: dark ? '#26221A' : '#FFF8E6',
    },
    space: (n: number) => n * 4,
    radius: Platform.select({ ios: { sm: 8, md: 12, lg: 16 }, default: { sm: 8, md: 12, lg: 20 } })!,
    font: {
      title: { fontSize: 22, fontWeight: '700' as const },
      heading: { fontSize: 17, fontWeight: '600' as const },
      body: { fontSize: 15, fontWeight: '400' as const },
      small: { fontSize: 13, fontWeight: '400' as const },
      tiny: { fontSize: 11, fontWeight: '500' as const },
      money: { fontVariant: ['tabular-nums' as const] },
    },
    shadow: Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: dark ? 0 : 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
      default: { elevation: dark ? 0 : 2 },
    })!,
  };
}

export const lightTheme = makeTheme(false);
export const darkTheme = makeTheme(true);

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? darkTheme : lightTheme;
}
