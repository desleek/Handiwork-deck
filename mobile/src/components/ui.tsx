import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import type { ComponentProps, ReactNode } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useState } from 'react';
import { useTheme } from '../theme';

export function Screen({ children, scroll = true, padded = true }: { children: ReactNode; scroll?: boolean; padded?: boolean }) {
  const t = useTheme();
  const inner = <View style={{ padding: padded ? t.space(4) : 0, gap: t.space(3) }}>{children}</View>;
  return (
    <SafeAreaView edges={['bottom']} style={{ flex: 1, backgroundColor: t.color.bg }}>
      {scroll ? <ScrollView keyboardShouldPersistTaps="handled">{inner}</ScrollView> : inner}
    </SafeAreaView>
  );
}

type TV = 'title' | 'heading' | 'body' | 'small' | 'tiny';
export function T({ v = 'body', muted, style, children, numberOfLines, selectable }: { v?: TV; muted?: boolean; style?: StyleProp<TextStyle>; children: ReactNode; numberOfLines?: number; selectable?: boolean }) {
  const t = useTheme();
  return (
    <Text numberOfLines={numberOfLines} selectable={selectable} style={[t.font[v], { color: muted ? t.color.textMuted : t.color.text }, style]}>
      {children}
    </Text>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <View style={[{ backgroundColor: t.color.surface, borderRadius: t.radius.md, padding: t.space(4), gap: t.space(2) }, t.shadow, style]}>
      {children}
    </View>
  );
}

export function Row({ children, style, gap = 2 }: { children: ReactNode; style?: StyleProp<ViewStyle>; gap?: number }) {
  const t = useTheme();
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: t.space(gap) }, style]}>{children}</View>;
}

export function Divider() {
  const t = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.color.border, marginVertical: t.space(1) }} />;
}

type ButtonKind = 'primary' | 'secondary' | 'danger' | 'ghost';
export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  loading,
  icon,
}: {
  title: string;
  onPress: () => void;
  kind?: ButtonKind;
  disabled?: boolean;
  loading?: boolean;
  icon?: string;
}) {
  const t = useTheme();
  const bg = { primary: t.color.primary, secondary: t.color.primarySoft, danger: t.color.danger, ghost: 'transparent' }[kind];
  const fg = { primary: t.color.primaryText, secondary: t.color.primary, danger: '#fff', ghost: t.color.primary }[kind];
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      android_ripple={{ color: 'rgba(255,255,255,0.2)' }}
      onPress={() => {
        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={({ pressed }) => ({
        backgroundColor: bg,
        opacity: disabled ? 0.45 : pressed && Platform.OS === 'ios' ? 0.75 : 1,
        borderRadius: Platform.OS === 'ios' ? t.radius.md : 100, // M3 uses fully rounded buttons
        paddingVertical: t.space(3.5),
        paddingHorizontal: t.space(5),
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: t.space(2),
        overflow: 'hidden',
      })}
    >
      {loading ? <ActivityIndicator color={fg} /> : icon ? <PlatformIcon name={icon} size={18} color={fg} /> : null}
      <Text style={[t.font.heading, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

/** Small honest label for paid placement / status (Section 14). */
export function Tag({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'promoted' | 'success' | 'warning' | 'danger' }) {
  const t = useTheme();
  const map = {
    neutral: [t.color.surfaceAlt, t.color.textMuted],
    promoted: ['transparent', t.color.promoted],
    success: [t.color.primarySoft, t.color.primary],
    warning: [t.color.accentSoft, t.color.promoted],
    danger: [t.color.dangerSoft, t.color.danger],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <View style={{ backgroundColor: bg, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, borderWidth: tone === 'promoted' ? 1 : 0, borderColor: fg }}>
      <Text style={[t.font.tiny, { color: fg }]}>{label}</Text>
    </View>
  );
}

/**
 * Icons: Ionicons (SF Symbols-style) on iOS, Material Community Icons on Android.
 * `name` is a Material Community name; common ones are mapped to Ionicons for iOS.
 */
const IOS_MAP: Record<string, ComponentProps<typeof Ionicons>['name']> = {
  'magnify': 'search',
  'briefcase-outline': 'briefcase-outline',
  'tag-outline': 'pricetag-outline',
  'wallet-outline': 'wallet-outline',
  'account-circle-outline': 'person-circle-outline',
  'map-outline': 'map-outline',
  'view-grid-outline': 'grid-outline',
  'star': 'star',
  'star-outline': 'star-outline',
  'chat-outline': 'chatbubble-outline',
  'send': 'send',
  'check': 'checkmark',
  'close': 'close',
  'chevron-right': 'chevron-forward',
  'flash': 'flash',
  'cash': 'cash-outline',
  'clipboard-text-outline': 'clipboard-outline',
  'chart-line': 'trending-up',
  'storefront-outline': 'storefront-outline',
  'cart-outline': 'cart-outline',
  'package-variant': 'cube-outline',
  'bullhorn-outline': 'megaphone-outline',
};

export function PlatformIcon({ name, size = 22, color }: { name: string; size?: number; color?: string }) {
  const t = useTheme();
  if (Platform.OS === 'ios' && IOS_MAP[name]) return <Ionicons name={IOS_MAP[name]} size={size} color={color ?? t.color.text} />;
  return <MaterialCommunityIcons name={name as any} size={size} color={color ?? t.color.text} />;
}

export function Loading() {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.space(8) }}>
      <ActivityIndicator color={t.color.primary} />
    </View>
  );
}

export function Banner({ text, tone = 'warning' }: { text: string; tone?: 'warning' | 'danger' | 'info' }) {
  const t = useTheme();
  const bg = tone === 'danger' ? t.color.dangerSoft : tone === 'info' ? t.color.primarySoft : t.color.accentSoft;
  return (
    <View style={{ backgroundColor: bg, borderRadius: t.radius.sm, padding: t.space(3) }}>
      <T v="small">{text}</T>
    </View>
  );
}

export function Empty({ title, body }: { title: string; body?: string }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', padding: t.space(8), gap: t.space(1) }}>
      <T v="heading">{title}</T>
      {body ? <T muted style={{ textAlign: 'center' }}>{body}</T> : null}
    </View>
  );
}

/**
 * Native choice sheet: ActionSheetIOS on iOS, a Material bottom sheet on Android.
 * Returns the chosen index, or null if dismissed.
 */
export function useChoiceSheet() {
  const t = useTheme();
  const [sheet, setSheet] = useState<{ title: string; options: string[]; resolve: (i: number | null) => void } | null>(null);

  const open = (title: string, options: string[], destructiveIndex?: number) =>
    new Promise<number | null>((resolve) => {
      if (Platform.OS === 'ios') {
        ActionSheetIOS.showActionSheetWithOptions(
          { title, options: [...options, 'Cancel'], cancelButtonIndex: options.length, destructiveButtonIndex: destructiveIndex },
          (i) => resolve(i === options.length ? null : i),
        );
      } else {
        setSheet({ title, options, resolve });
      }
    });

  const element =
    Platform.OS === 'android' && sheet ? (
      <Modal transparent animationType="slide" onRequestClose={() => { sheet.resolve(null); setSheet(null); }}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }} onPress={() => { sheet.resolve(null); setSheet(null); }} />
        <View style={{ backgroundColor: t.color.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: t.space(4), paddingBottom: t.space(8) }}>
          <View style={{ alignSelf: 'center', width: 32, height: 4, borderRadius: 2, backgroundColor: t.color.border, marginBottom: t.space(3) }} />
          <T v="heading" style={{ marginBottom: t.space(2) }}>{sheet.title}</T>
          {sheet.options.map((o, i) => (
            <Pressable key={o} android_ripple={{ color: t.color.border }} style={{ paddingVertical: t.space(3.5) }} onPress={() => { sheet.resolve(i); setSheet(null); }}>
              <T>{o}</T>
            </Pressable>
          ))}
        </View>
      </Modal>
    ) : null;

  return { open, element };
}
