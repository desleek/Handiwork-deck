import type { ServiceSegment } from '@handiwork/shared';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';

export { SEGMENT_LABEL } from '@handiwork/shared';

export interface Category {
  id: number;
  slug: string;
  name: string;
  segment: ServiceSegment;
  icon: string | null;
  description: string | null;
  is_other: boolean;
}

export type IconName = ComponentProps<typeof Ionicons>['name'];

/** Category icons are admin-editable strings; fall back if an unknown glyph is set. */
export function iconFor(name: string | null | undefined): IconName {
  return (name && name in Ionicons.glyphMap ? name : 'construct') as IconName;
}
