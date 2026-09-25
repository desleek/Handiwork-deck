import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';
import { colors } from './ui';

export const tabScreenOptions = {
  tabBarActiveTintColor: colors.primary,
  headerTintColor: colors.ink,
  sceneStyle: { backgroundColor: colors.bg },
};

export const tabIcon =
  (name: ComponentProps<typeof Ionicons>['name']) =>
  ({ color, size }: { color: unknown; size: number }) => <Ionicons name={name} color={String(color)} size={size} />;
