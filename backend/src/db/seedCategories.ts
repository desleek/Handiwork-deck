/**
 * Initial service taxonomy (Section 2). This only seeds the table — categories are
 * admin-managed at runtime (add / edit / deactivate), never read from this file by the app.
 * Icons are MaterialCommunityIcons names (bundled with Expo's @expo/vector-icons).
 *
 * The source list contained exact duplicates ("Phone repair", "Photographer request"),
 * which are seeded once. Near-duplicates (e.g. "Electrical" vs "Electrical repair",
 * "Cleaning services" vs "Cleaner request") are kept so the admin can decide to merge or deactivate.
 */
export interface SeedCategory {
  name: string;
  icon: string;
  isCustom?: boolean;
}

export const HOUSEHOLD_OFFICE: SeedCategory[] = [
  { name: 'Plumbing', icon: 'pipe-wrench' },
  { name: 'Electrical', icon: 'flash' },
  { name: 'HVAC / AC repair', icon: 'air-conditioner' },
  { name: 'Appliance repair', icon: 'washing-machine' },
  { name: 'Generator repair / servicing', icon: 'engine' },
  { name: 'Carpentry & furniture repair / assembly', icon: 'hand-saw' },
  { name: 'Painting & wall finishing', icon: 'format-paint' },
  { name: 'Masonry / tiling / POP', icon: 'wall' },
  { name: 'Locksmith & security fittings', icon: 'lock' },
  { name: 'Pest control & fumigation', icon: 'bug' },
  { name: 'Cleaning services', icon: 'broom' },
  { name: 'CCTV / alarm / security installation', icon: 'cctv' },
  { name: 'Networking & IT support', icon: 'lan' },
  { name: 'Phone repair', icon: 'cellphone-cog' },
  { name: 'Wrist watch repair', icon: 'watch' },
  { name: 'Electronics repair', icon: 'chip' },
  { name: 'Electrical repair', icon: 'power-plug' },
  { name: 'Furniture repair', icon: 'sofa' },
  { name: 'Cloth repair', icon: 'needle' },
  { name: 'Facial make-up', icon: 'lipstick' },
  { name: 'Hair dresser', icon: 'hair-dryer' },
  { name: 'Nail fix', icon: 'hand-back-right' },
  { name: 'DJ request', icon: 'album' },
  { name: 'Canopy / chair request', icon: 'chair-rolling' },
  { name: 'Photographer request', icon: 'camera' },
  { name: 'Tailor request', icon: 'tshirt-crew' },
  { name: 'Table / sachet water request', icon: 'water' },
  { name: 'Borehole repair', icon: 'water-pump' },
  { name: 'Therapist request', icon: 'meditation' },
  { name: 'Nurse request', icon: 'medical-bag' },
  { name: 'Cleaner request', icon: 'spray-bottle' },
  { name: 'Dry cleaner request', icon: 'iron' },
  { name: 'Car wash request', icon: 'car-wash' },
  { name: 'Driver request', icon: 'steering' },
  { name: 'Event planner request', icon: 'calendar-star' },
  { name: 'Party decorator request', icon: 'party-popper' },
  { name: 'Butcher request', icon: 'food-steak' },
  { name: 'Party pot request', icon: 'pot-steam' },
  { name: 'Bartender request', icon: 'glass-cocktail' },
  { name: 'Party speaker request', icon: 'speaker' },
  { name: 'Printing request', icon: 'printer' },
  { name: 'Aluminium repair', icon: 'window-closed-variant' },
  { name: 'Shoe maker', icon: 'shoe-formal' },
  { name: 'Waste manager request', icon: 'delete-empty' },
  { name: 'Vulcanizer request', icon: 'tire' },
  { name: 'Auto mechanic request', icon: 'car-wrench' },
  { name: 'Auto electrician request', icon: 'car-battery' },
  { name: 'Barber', icon: 'content-cut' },
  { name: 'Spa request', icon: 'spa' },
  { name: 'Auto panel beater request', icon: 'car-door' },
  { name: 'Household security request', icon: 'shield-home' },
  { name: 'Upholstery repair', icon: 'seat' },
  { name: 'Food vendor request', icon: 'food' },
  { name: 'Interior designer request', icon: 'floor-plan' },
  { name: 'Cook / chef request', icon: 'chef-hat' },
  { name: 'Computer / office equipment repair', icon: 'desktop-classic' },
  { name: 'Solar & inverter installation / maintenance', icon: 'solar-panel' },
  { name: 'Interior / furniture installation', icon: 'table-furniture' },
  { name: 'Landscaping & gardening', icon: 'flower' },
  { name: 'Fire safety equipment servicing', icon: 'fire-extinguisher' },
  { name: 'Other / custom', icon: 'dots-horizontal-circle', isCustom: true },
];

export const CONSTRUCTION: SeedCategory[] = [
  { name: 'Bricklaying / masonry', icon: 'wall' },
  { name: 'Iron bending / rebar work', icon: 'grid' },
  { name: 'Welding & fabrication', icon: 'fire' },
  { name: 'Structural carpentry', icon: 'hammer' },
  { name: 'Scaffolding / plant erection', icon: 'crane' },
  { name: 'Land piling', icon: 'excavator' },
  { name: 'Window fixing', icon: 'window-open-variant' },
  { name: 'Tiling', icon: 'checkerboard' },
  { name: 'Roofing', icon: 'home-roof' },
  { name: 'Other construction trade', icon: 'dots-horizontal-circle', isCustom: true },
];

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
