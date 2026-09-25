import { pool } from './pool';

/** Promotes an existing user to admin: `npm run db:make-admin -- someone@example.com` */
const email = process.argv[2];
if (!email) {
  console.error('Usage: npm run db:make-admin -- <email>');
  process.exit(1);
}
const res = await pool.query(`UPDATE users SET role = 'admin', customer_type = NULL WHERE lower(email) = lower($1) RETURNING id`, [email]);
console.log(res.rowCount ? `Promoted ${email} to admin` : `No user with email ${email}`);
await pool.end();
