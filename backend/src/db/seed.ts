import { pool } from './pool.ts';
import { CONSTRUCTION, HOUSEHOLD_OFFICE, slugify, type SeedCategory } from './seedCategories.ts';

async function seedGroup(supercategory: 'household_office' | 'construction', items: SeedCategory[]) {
  let order = 0;
  for (const c of items) {
    order += 10;
    await pool.query(
      `INSERT INTO service_categories (supercategory, name, slug, icon, is_custom, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (slug) DO NOTHING`,
      [supercategory, c.name, `${supercategory === 'construction' ? 'c-' : ''}${slugify(c.name)}`, c.icon, !!c.isCustom, order],
    );
  }
}

async function main() {
  await seedGroup('household_office', HOUSEHOLD_OFFICE);
  await seedGroup('construction', CONSTRUCTION);

  // A first admin account for local development (sign in with x-dev-user-id in AUTH_MODE=dev).
  await pool.query(
    `INSERT INTO users (id, role, full_name, email)
     VALUES ('00000000-0000-0000-0000-000000000001', 'admin', 'Platform Admin', 'admin@handiworkdeck.local')
     ON CONFLICT (id) DO NOTHING`,
  );

  const { rows } = await pool.query('SELECT supercategory, count(*)::int AS n FROM service_categories GROUP BY 1');
  console.log('categories:', rows);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
