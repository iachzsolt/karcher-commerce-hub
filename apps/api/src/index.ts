import 'dotenv/config'
import { serve } from '@hono/node-server'
import { neon } from '@neondatabase/serverless'
import { Hono } from 'hono'
import { cors } from 'hono/cors'

const app = new Hono()

app.use(
  '*',
  cors({
    origin: 'http://localhost:5173',
  }),
)

app.get('/', (context) => {
  return context.json({
    name: 'Kärcher Commerce Hub API',
    version: '0.1.0',
  })
})

app.get('/health', (context) => {
  return context.json({
    status: 'ok',
    service: 'commerce-hub-api',
    environment: 'development',
    timestamp: new Date().toISOString(),
  })
})

app.get('/database/health', async (context) => {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl) {
    return context.json(
      {
        status: 'error',
        database: 'not-configured',
      },
      500,
    )
  }

  try {
    const sql = neon(databaseUrl)

    const result = await sql`
      SELECT
        current_database() AS database_name,
        NOW() AS database_time
    `

    return context.json({
      status: 'ok',
      database: 'postgresql',
      provider: 'neon',
      databaseName: result[0].database_name,
      databaseTime: result[0].database_time,
    })
  } catch (error) {
    console.error('Database health check failed:', error)

    return context.json(
      {
        status: 'error',
        database: 'unreachable',
      },
      500,
    )
  }
})

const port = 3000

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`Commerce Hub API: http://localhost:${info.port}`)
    console.log(`Health check: http://localhost:${info.port}/health`)
    console.log(
      `Database health: http://localhost:${info.port}/database/health`,
    )
  },
)