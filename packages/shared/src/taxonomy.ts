import type { ServiceSegment } from './roles';

/** Display names for the two supercategories. */
export const SEGMENT_LABEL: Record<ServiceSegment, string> = {
  household_office: 'Household & Office Technical Support',
  construction_plant: 'Construction & Plant Erection',
};

export interface CategoryDefinition {
  slug: string;
  name: string;
  segment: ServiceSegment;
  /** Ionicons glyph name used by the app. */
  icon: string;
  /** The catch-all "Other" entry: jobs posted under it name a custom service that an admin must approve. */
  isOther?: boolean;
}

const H = (slug: string, name: string, icon: string, isOther = false): CategoryDefinition => ({
  slug,
  name,
  segment: 'household_office',
  icon,
  isOther,
});
const C = (slug: string, name: string, icon: string, isOther = false): CategoryDefinition => ({
  slug,
  name,
  segment: 'construction_plant',
  icon,
  isOther,
});

/**
 * The launch taxonomy. This is only the *initial* data loaded by migration
 * 002; afterwards categories live in the database and admins add, edit and
 * deactivate them. Keep in sync with that migration if you edit it.
 */
export const DEFAULT_TAXONOMY: readonly CategoryDefinition[] = [
  H('plumbing', 'Plumbing', 'water'),
  H('electrical', 'Electrical', 'flash'),
  H('hvac-ac-repair', 'HVAC / AC repair', 'snow'),
  H('appliance-repair', 'Appliance repair', 'tv'),
  H('generator-repair', 'Generator repair / servicing', 'battery-charging'),
  H('carpentry', 'Carpentry & furniture repair / assembly', 'hammer'),
  H('painting', 'Painting & wall finishing', 'color-palette'),
  H('masonry-tiling-pop', 'Masonry / tiling / POP', 'grid'),
  H('locksmith', 'Locksmith & security fittings', 'key'),
  H('pest-control', 'Pest control & fumigation', 'bug'),
  H('cleaning', 'Cleaning services', 'sparkles'),
  H('cctv-security', 'CCTV / alarm / security installation', 'videocam'),
  H('it-networking', 'Networking & IT support', 'wifi'),
  H('phone-repair', 'Phone repair', 'phone-portrait'),
  H('watch-repair', 'Wrist watch repair', 'watch'),
  H('electronics-repair', 'Electronics repair', 'hardware-chip'),
  H('electrical-repair', 'Electrical repair', 'flash-outline'),
  H('furniture-repair', 'Furniture repair', 'bed'),
  H('cloth-repair', 'Cloth repair', 'shirt'),
  H('makeup', 'Facial make-up', 'happy'),
  H('hairdresser', 'Hair dresser', 'cut'),
  H('nails', 'Nail technician', 'hand-left'),
  H('dj', 'DJ', 'musical-notes'),
  H('canopy-chair-rental', 'Canopy / chair rental', 'umbrella'),
  H('photographer', 'Photographer', 'camera'),
  H('tailor', 'Tailor', 'shirt-outline'),
  H('table-sachet-water', 'Table / sachet water supply', 'water-outline'),
  H('borehole-repair', 'Borehole repair', 'water'),
  H('therapist', 'Therapist', 'heart'),
  H('nurse', 'Nurse', 'medkit'),
  H('cleaner', 'Cleaner', 'sparkles-outline'),
  H('dry-cleaner', 'Dry cleaner', 'shirt'),
  H('car-wash', 'Car wash', 'car-sport'),
  H('driver', 'Driver', 'car'),
  H('event-planner', 'Event planner', 'calendar'),
  H('party-decorator', 'Party decorator', 'balloon'),
  H('butcher', 'Butcher', 'restaurant'),
  H('party-pot', 'Party pot / cooking pots', 'flame'),
  H('bartender', 'Bartender', 'wine'),
  H('party-speaker', 'Party speaker rental', 'volume-high'),
  H('printing', 'Printing', 'print'),
  H('aluminum-repair', 'Aluminum repair', 'grid-outline'),
  H('shoe-maker', 'Shoe maker', 'footsteps'),
  H('waste-management', 'Waste management', 'trash'),
  H('vulcanizer', 'Vulcanizer', 'disc'),
  H('auto-mechanic', 'Auto mechanic', 'construct'),
  H('auto-electrician', 'Auto electrician', 'car-outline'),
  H('barber', 'Barber', 'cut-outline'),
  H('spa', 'Spa', 'flower'),
  H('panel-beater', 'Auto panel beater', 'car-sport-outline'),
  H('household-security', 'Household security', 'shield-checkmark'),
  H('upholstery', 'Upholstery repair', 'bed-outline'),
  H('food-vendor', 'Food vendor', 'fast-food'),
  H('interior-designer', 'Interior designer', 'color-wand'),
  H('cook-chef', 'Cook / chef', 'restaurant-outline'),
  H('computer-office-equipment', 'Computer / office equipment repair', 'desktop'),
  H('solar-inverter', 'Solar & inverter installation / maintenance', 'sunny'),
  H('interior-furniture-installation', 'Interior / furniture installation', 'easel'),
  H('landscaping', 'Landscaping & gardening', 'leaf'),
  H('fire-safety', 'Fire safety equipment servicing', 'bonfire'),
  H('other-household', 'Other / custom service', 'add-circle', true),

  C('bricklaying-masonry', 'Bricklaying / masonry', 'cube'),
  C('iron-bending', 'Iron bending / rebar work', 'reorder-four'),
  C('welding-fabrication', 'Welding & fabrication', 'flame'),
  C('structural-carpentry', 'Structural carpentry', 'hammer'),
  C('scaffolding', 'Scaffolding / plant erection', 'business'),
  C('land-piling', 'Land piling', 'arrow-down-circle'),
  C('window-fixing', 'Window fixing', 'browsers'),
  C('tiling', 'Tiling', 'grid'),
  C('roofing', 'Roofing', 'home'),
  C('other-construction', 'Other construction trade', 'add-circle', true),
];
