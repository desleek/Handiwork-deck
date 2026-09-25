import type { ServiceSegment } from '@handiwork/shared';

export interface Category {
  id: number;
  slug: string;
  name: string;
  segment: ServiceSegment;
  icon: string | null;
}

export const SEGMENT_LABEL: Record<ServiceSegment, string> = {
  household_office: 'Home & office',
  construction_plant: 'Construction & plant erection',
};
