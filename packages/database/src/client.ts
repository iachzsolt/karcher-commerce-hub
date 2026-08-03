import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'

export function createDatabase(databaseUrl: string) {
  const sql = neon(databaseUrl)

  return drizzle(sql)
}