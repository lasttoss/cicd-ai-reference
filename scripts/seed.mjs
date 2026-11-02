// Idempotent seed: one throwaway QA account, hashed with scrypt.
import { randomBytes, scryptSync } from 'node:crypto';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const email = process.env.SEED_EMAIL || 'qa1@test.local';
const pass = process.env.SEED_PASS || 'qa-pass';
const salt = randomBytes(16);
const hash = `scrypt:${salt.toString('hex')}:${scryptSync(pass, salt, 32).toString('hex')}`;

await pool.query(
  `INSERT INTO users (email, pass_hash) VALUES ($1, $2)
   ON CONFLICT (email) DO UPDATE SET pass_hash = EXCLUDED.pass_hash`, [email, hash]);
await pool.query(
  `INSERT INTO addresses (user_id, line)
   SELECT id, '1 Example Street' FROM users WHERE email = $1
   ON CONFLICT (user_id) DO NOTHING`, [email]);
console.log(`seeded ${email}`);
await pool.end();
