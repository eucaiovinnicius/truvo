import { config } from 'dotenv';
// drizzle-kit roda com cwd em packages/db — o .env fica na raiz do monorepo.
config({ path: '../../.env' });
import { defineConfig } from 'drizzle-kit';

// Migrations do Postgres (Supabase). Requer DATABASE_URL no .env.
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  verbose: false,
  strict: false,
});
