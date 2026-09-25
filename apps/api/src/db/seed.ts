import { pool } from './pool';

const CATEGORIES: [slug: string, name: string, segment: 'household_office' | 'construction_plant', icon: string][] = [
  ['plumbing', 'Plumbing', 'household_office', 'water'],
  ['electrical', 'Electrical', 'household_office', 'flash'],
  ['ac-refrigeration', 'AC & Refrigeration', 'household_office', 'snow'],
  ['generator-repair', 'Generator Repair', 'household_office', 'battery-charging'],
  ['solar-inverter', 'Solar & Inverter', 'household_office', 'sunny'],
  ['appliance-repair', 'Appliance Repair', 'household_office', 'construct'],
  ['it-networking', 'IT & Networking', 'household_office', 'wifi'],
  ['cctv-security', 'CCTV & Security', 'household_office', 'videocam'],
  ['carpentry', 'Carpentry & Furniture', 'household_office', 'hammer'],
  ['painting', 'Painting & Decorating', 'household_office', 'color-palette'],
  ['cleaning', 'Cleaning & Fumigation', 'household_office', 'sparkles'],
  ['masonry', 'Masonry & Bricklaying', 'construction_plant', 'cube'],
  ['tiling', 'Tiling & Flooring', 'construction_plant', 'grid'],
  ['welding-fabrication', 'Welding & Fabrication', 'construction_plant', 'flame'],
  ['roofing', 'Roofing', 'construction_plant', 'home'],
  ['scaffolding', 'Scaffolding', 'construction_plant', 'git-network'],
  ['steel-erection', 'Steel & Plant Erection', 'construction_plant', 'business'],
  ['crane-plant-operator', 'Crane & Plant Operators', 'construction_plant', 'car'],
  ['borehole-drilling', 'Borehole Drilling', 'construction_plant', 'water'],
  ['pipefitting', 'Industrial Pipefitting', 'construction_plant', 'git-merge'],
];

async function seed() {
  for (const [i, [slug, name, segment, icon]] of CATEGORIES.entries()) {
    await pool.query(
      `INSERT INTO service_categories (slug, name, segment, icon, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, segment = EXCLUDED.segment, icon = EXCLUDED.icon`,
      [slug, name, segment, icon, i],
    );
  }
  console.log(`Seeded ${CATEGORIES.length} service categories`);
}

seed()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
