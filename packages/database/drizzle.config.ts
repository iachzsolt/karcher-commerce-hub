import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'
import { resolve } from 'node:path'

config({
  path: resolve(process.cwd(), '../../apps/api/.env'),
})

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not configured')
}

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  verbose: true,
  strict: true,
})