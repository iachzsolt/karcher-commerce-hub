import { config } from 'dotenv'
import { resolve } from 'node:path'
import { createDatabase } from './client.js'
import {
  platforms,
  productIdentifiers,
  products,
} from './schema.js'

config({
  path: resolve(process.cwd(), '../../apps/api/.env'),
})

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL is not configured')
}

const db = createDatabase(databaseUrl)

async function seed() {
  console.log('Starting Commerce Hub seed...')

  await db
    .insert(platforms)
    .values([
      {
        code: 'ALLEGRO',
        name: 'Allegro',
      },
      {
        code: 'ARUKERESO',
        name: 'ĂrukeresĹ‘',
      },
    ])
    .onConflictDoNothing()

  console.log('Platforms seeded.')

  const productResult = await db
    .insert(products)
    .values({
      sku: 'TEST-001',
      name: 'Commerce Hub tesztterm\u00E9k',
      productLine: 'UNASSIGNED',
    })
    .onConflictDoUpdate({
      target: products.sku,
      set: {
        name: 'Commerce Hub tesztterm\u00E9k',
      },
    })
    .returning({
      id: products.id,
    })

  const product = productResult[0]

  await db
    .insert(productIdentifiers)
    .values({
      productId: product.id,
      type: 'OTHER',
      value: 'TEST-ID-001',
    })
    .onConflictDoNothing()

  console.log('Test product seeded.')
  console.log('Seed completed.')
}

try {
  await seed()
} catch (error) {
  console.error('Seed failed:', error)
  process.exitCode = 1
}