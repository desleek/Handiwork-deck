import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import type { ComponentProps, ReactNode } from 'react';
import { useState } from 'react';
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
import { useTheme } from '../theme';

// ============================================================================ layout

/**
 * Standard screen. `footer` pins content (usually the main action) above the home indicator;
 * `edges` lets screens without a native header handle the top inset themselves.
 */
export function Screen({
  children,
  scroll = true,
  padded = true,
  footer,
  header,
  edges = ['bottom'],
}: {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
  footer?: ReactNode;
  header?: ReactNode;
  edges?: ('top' | 'bottom')[];
}) {
  const t = useTheme();
  const inner = <View style={{ padding: padded ? t.space(5) : 0, paddingTop: padded ? t.space(3) : 0, gap: t.space(4) }}>{children}</View>;
  return (
    <SafeAreaView edges={footer ? edges.filter((e) => e !== 'bottom') : edges} style={{ flex: 1, backgroundColor: t.color.bg }}>
      {header}
      {scroll ? (
        <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }}>
          {inner}
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>{inner}</View>
      )}
      {footer ? <Footer>{footer}</Footer> : null}
    </SafeAreaView>
  );
}

/** Sticky action area at the bottom of a screen. */
export function Footer({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <SafeAreaView edges={['bottom']} style={{ backgroundColor: t.color.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.color.border }}>
      <View style={{ paddingHorizontal: t.space(5), paddingTop: t.space(3), paddingBottom: t.space(3), gap: t.space(2.5) }}>{children}</View>
    </SafeAreaView>
  );
}

/** In-content header for screens that hide the native one: back button, title, subtitle, trailing slot. */
export function ScreenHeader({ title, subtitle, right, back = true, onBack }: { title: string; subtitle?: string; right?: ReactNode; back?: boolean; onBack?: () => void }) {
  const t = useTheme();
  return (
    <Row gap={3} style={{ paddingHorizontal: t.space(5), paddingTop: t.space(3), paddingBottom: t.space(2) }}>
      {back ? <IconButton icon="chevron-left" label="Back" onPress={onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')))} /> : null}
      <View style={{ flex: 1 }}>
        <T v="title" numberOfLines={1}>{title}</T>
        {subtitle ? <T v="small" muted numberOfLines={1}>{subtitle}</T> : null}
      </View>
      {right}
    </Row>
  );
}

export function Row({ children, style, gap = 2 }: { children: ReactNode; style?: StyleProp<ViewStyle>; gap?: number }) {
  const t = useTheme();
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: t.space(gap) }, style]}>{children}</View>;
}

export function Divider({ inset = 0 }: { inset?: number }) {
  const t = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.color.border, marginVertical: t.space(1), marginHorizontal: inset }} />;
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ gap: t.space(2.5) }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T v="heading">{title}</T>
        {right}
      </Row>
      {children}
    </View>
  );
}

// ============================================================================ text

type TV = 'display' | 'title' | 'heading' | 'body' | 'bodyStrong' | 'small' | 'smallStrong' | 'tiny' | 'label' | 'amount';
export function T({
  v = 'body',
  muted,
  color,
  style,
  children,
  numberOfLines,
  selectable,
}: {
  v?: TV;
  muted?: boolean;
  color?: string;
  style?: StyleProp<TextStyle>;
  children: ReactNode;
  numberOfLines?: number;
  selectable?: boolean;
}) {
  const t = useTheme();
  return (
    <Text
      numberOfLines={numberOfLines}
      selectable={selectable}
      maxFontSizeMultiplier={1.6}
      style={[t.font[v], v === 'amount' ? t.font.money : null, { color: color ?? (muted ? t.color.textMuted : t.color.text) }, style]}
    >
      {children}
    </Text>
  );
}

// ============================================================================ surfaces

export function Card({ children, style, tone = 'default' }: { children: ReactNode; style?: StyleProp<ViewStyle>; tone?: 'default' | 'attention' | 'selected' }) {
  const t = useTheme();
  const borderColor = tone === 'attention' ? t.color.accent : tone === 'selected' ? t.color.primary : t.color.border;
  return (
    <View
      style={[
        { backgroundColor: t.color.surface, borderRadius: t.radius.lg, padding: t.space(4), gap: t.space(2.5), borderWidth: tone === 'default' ? 1 : 1.5, borderColor },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Calm reassurance strip (escrow, privacy). Icon + text, never colour alone. */
export function Note({ icon = 'shield-check-outline', title, text, tone = 'brand' }: { icon?: string; title?: string; text: string; tone?: 'brand' | 'attention' | 'neutral' }) {
  const t = useTheme();
  const bg = tone === 'attention' ? t.color.accentSoft : tone === 'neutral' ? t.color.surfaceAlt : t.color.primarySoft;
  const fg = tone === 'attention' ? t.color.accentInk : t.color.primary;
  return (
    <Row gap={3} style={{ backgroundColor: bg, borderRadius: t.radius.md, padding: t.space(3.5), alignItems: 'flex-start' }}>
      <PlatformIcon name={icon} size={22} color={fg} />
      <Text style={[t.font.small, { flex: 1, color: t.color.text }]}>
        {title ? <Text style={t.font.smallStrong}>{title} </Text> : null}
        {text}
      </Text>
    </Row>
  );
}

export function Banner({ text, tone = 'warning' }: { text: string; tone?: 'warning' | 'danger' | 'info' }) {
  const t = useTheme();
  const bg = tone === 'danger' ? t.color.dangerSoft : tone === 'info' ? t.color.primarySoft : t.color.accentSoft;
  const icon = tone === 'danger' ? 'alert-circle-outline' : tone === 'info' ? 'information-outline' : 'alert-outline';
  const fg = tone === 'danger' ? t.color.danger : tone === 'info' ? t.color.primary : t.color.accentInk;
  return (
    <Row gap={2.5} style={{ backgroundColor: bg, borderRadius: t.radius.md, padding: t.space(3.5), alignItems: 'flex-start' }}>
      <PlatformIcon name={icon} size={20} color={fg} />
      <T v="small" style={{ flex: 1 }}>{text}</T>
    </Row>
  );
}

// ============================================================================ controls

type ButtonKind = 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline';
export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  loading,
  icon,
  size = 'lg',
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: ButtonKind;
  disabled?: boolean;
  loading?: boolean;
  icon?: string;
  size?: 'lg' | 'md';
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const bg = { primary: t.color.primaryFill, secondary: t.color.primarySoft, danger: t.color.danger, ghost: 'transparent', outline: t.color.surface }[kind];
  const fg = { primary: t.color.primaryText, secondary: t.color.primary, danger: '#fff', ghost: t.color.primary, outline: t.color.text }[kind];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      disabled={disabled || loading}
      android_ripple={{ color: kind === 'primary' || kind === 'danger' ? 'rgba(255,255,255,0.2)' : t.color.border }}
      onPress={() => {
        if (Platform.OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          opacity: disabled ? 0.45 : pressed && Platform.OS === 'ios' ? 0.8 : 1,
          borderRadius: t.radius.md,
          minHeight: size === 'lg' ? 54 : 44,
          paddingHorizontal: t.space(4),
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: t.space(2),
          overflow: 'hidden',
          borderWidth: kind === 'outline' ? 1 : 0,
          borderColor: t.color.border,
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : icon ? <PlatformIcon name={icon} size={18} color={fg} /> : null}
      <Text style={[t.font.button, size === 'md' ? { fontSize: 14 } : null, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

/** 44×44 square icon button with an accessible label. `onDark` for the green/ink header bands. */
export function IconButton({ icon, label, onPress, onDark, badge }: { icon: string; label: string; onPress: () => void; onDark?: boolean; badge?: boolean }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: onDark ? t.color.heroRaised : t.color.surface,
        borderWidth: onDark ? 0 : 1,
        borderColor: t.color.border,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <PlatformIcon name={icon} size={22} color={onDark ? t.color.heroText : t.color.text} />
      {badge ? <View style={{ position: 'absolute', top: 9, right: 10, width: 9, height: 9, borderRadius: 5, backgroundColor: t.color.star, borderWidth: 2, borderColor: t.color.surface }} /> : null}
    </Pressable>
  );
}

/** Pill-shaped segmented tabs (profile sections, job lists). */
export function Segmented<K extends string>({ value, onChange, options, onDark }: { value: K; onChange: (k: K) => void; options: { key: K; label: string }[]; onDark?: boolean }) {
  const t = useTheme();
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', backgroundColor: t.color.surfaceAlt, borderRadius: 14, padding: 4 }}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => {
              Haptics.selectionAsync();
              onChange(o.key);
            }}
            style={{ flex: 1, height: 40, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.color.surface : 'transparent' }}
          >
            <T v="smallStrong" color={on ? t.color.text : t.color.textMuted} style={{ fontSize: 14 }}>{o.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Selectable chip (time slots, days). */
export function Chip({ label, sub, selected, onPress, solid }: { label: string; sub?: string; selected: boolean; onPress: () => void; solid?: boolean }) {
  const t = useTheme();
  const bg = selected ? (solid ? t.color.primaryFill : t.color.primarySoft) : t.color.surface;
  const fg = selected && solid ? t.color.primaryText : t.color.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={() => {
        Haptics.selectionAsync();
        onPress();
      }}
      style={{ flex: 1, minHeight: sub ? 60 : 44, borderRadius: 14, borderWidth: 1.5, borderColor: selected ? t.color.primary : t.color.border, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', gap: 2 }}
    >
      <T v="smallStrong" color={fg} style={{ fontSize: 14 }}>{label}</T>
      {sub ? <T v="tiny" muted>{sub}</T> : null}
    </Pressable>
  );
}

// ============================================================================ status & identity

type TagTone = 'neutral' | 'promoted' | 'success' | 'warning' | 'danger' | 'attention';
/** Small honest label for paid placement / status (Section 14). Always text, never colour alone. */
export function Tag({ label, tone = 'neutral', icon }: { label: string; tone?: TagTone; icon?: string }) {
  const t = useTheme();
  const map: Record<TagTone, [string, string]> = {
    neutral: [t.color.surfaceAlt, t.color.textSoft],
    promoted: ['transparent', t.color.promoted],
    success: [t.color.primarySoft, t.color.primary],
    warning: [t.color.accentSoft, t.color.accentInk],
    attention: [t.color.accent, '#17211C'],
    danger: [t.color.dangerSoft, t.color.danger],
  };
  const [bg, fg] = map[tone];
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        alignSelf: 'flex-start',
        backgroundColor: bg,
        borderRadius: t.radius.pill,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderWidth: tone === 'promoted' ? 1 : 0,
        borderColor: fg,
      }}
    >
      {icon ? <PlatformIcon name={icon} size={13} color={fg} /> : null}
      <Text style={[t.font.tiny, { color: fg }]}>{label}</Text>
    </View>
  );
}

/** Photo if there is one, otherwise initials on a tinted square. */
export function Avatar({ name, url, size = 56, tone = 'green' }: { name: string; url?: string | null; size?: number; tone?: 'green' | 'marigold' }) {
  const t = useTheme();
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
  const radius = Math.round(size * 0.29);
  if (url) return <Image source={{ uri: url }} style={{ width: size, height: size, borderRadius: radius }} contentFit="cover" accessibilityLabel={name} />;
  return (
    <View style={{ width: size, height: size, borderRadius: radius, backgroundColor: tone === 'green' ? '#D8E8E0' : '#F7E3BE', alignItems: 'center', justifyContent: 'center' }}>
      <Text style={[t.font.title, { fontSize: Math.round(size * 0.36), lineHeight: undefined, color: tone === 'green' ? '#0F5C45' : '#8A5300' }]}>{initials}</Text>
    </View>
  );
}

export function VerifiedMark({ size = 16 }: { size?: number }) {
  const t = useTheme();
  return (
    <View accessible accessibilityLabel="Verified">
      <MaterialCommunityIcons name="check-decagram" size={size} color={t.color.primary} />
    </View>
  );
}

// ============================================================================ icons

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
  'account-outline': 'person-outline',
  'map-outline': 'map-outline',
  'view-grid-outline': 'grid-outline',
  'star': 'star',
  'star-outline': 'star-outline',
  'chat-outline': 'chatbubble-outline',
  'send': 'send',
  'check': 'checkmark',
  'close': 'close',
  'chevron-right': 'chevron-forward',
  'chevron-left': 'chevron-back',
  'chevron-down': 'chevron-down',
  'flash': 'flash',
  'cash': 'cash-outline',
  'clipboard-text-outline': 'clipboard-outline',
  'chart-line': 'trending-up',
  'storefront-outline': 'storefront-outline',
  'cart-outline': 'cart-outline',
  'package-variant': 'cube-outline',
  'package-variant-closed': 'cube-outline',
  'bullhorn-outline': 'megaphone-outline',
  'home-outline': 'home-outline',
  'bell-outline': 'notifications-outline',
  'map-marker-outline': 'location-outline',
  'shield-check-outline': 'shield-checkmark-outline',
  'lock-outline': 'lock-closed-outline',
  'clock-outline': 'time-outline',
  'credit-card-outline': 'card-outline',
  'bank-outline': 'business-outline',
  'dialpad': 'keypad-outline',
  'wrench-outline': 'construct-outline',
  'heart-outline': 'heart-outline',
  'information-outline': 'information-circle-outline',
  'alert-circle-outline': 'alert-circle-outline',
  'alert-outline': 'warning-outline',
  'tray-arrow-down': 'file-tray-outline',
  'file-document-outline': 'document-text-outline',
};

export function PlatformIcon({ name, size = 22, color }: { name: string; size?: number; color?: string }) {
  const t = useTheme();
  if (Platform.OS === 'ios' && IOS_MAP[name]) return <Ionicons name={IOS_MAP[name]} size={size} color={color ?? t.color.text} />;
  return <MaterialCommunityIcons name={name as any} size={size} color={color ?? t.color.text} />;
}

// ============================================================================ states

export function Loading() {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.space(8), backgroundColor: t.color.bg }}>
      <ActivityIndicator color={t.color.primary} />
    </View>
  );
}

export function Empty({ title, body, icon = 'tray-arrow-down' }: { title: string; body?: string; icon?: string }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', padding: t.space(8), gap: t.space(2) }}>
      <View style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: t.color.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
        <PlatformIcon name={icon} size={26} color={t.color.textMuted} />
      </View>
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
        <View style={{ backgroundColor: t.color.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: t.space(5), paddingBottom: t.space(8) }}>
          <View style={{ alignSelf: 'center', width: 32, height: 4, borderRadius: 2, backgroundColor: t.color.border, marginBottom: t.space(3) }} />
          <T v="heading" style={{ marginBottom: t.space(2) }}>{sheet.title}</T>
          {sheet.options.map((o, i) => (
            <Pressable key={o} android_ripple={{ color: t.color.border }} style={{ minHeight: 48, justifyContent: 'center' }} onPress={() => { sheet.resolve(i); setSheet(null); }}>
              <T>{o}</T>
            </Pressable>
          ))}
        </View>
      </Modal>
    ) : null;

  return { open, element };
}
