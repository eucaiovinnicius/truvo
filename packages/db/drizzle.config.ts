import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Migrations do Postgres (Supabase). Requer DATABASE_URL no .env.
export default defineConfig({
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  verbose: true,
  strict: true,
});
