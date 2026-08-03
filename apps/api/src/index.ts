import { serve } from '@hono/node-server'
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

const port = 3000

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`Commerce Hub API: http://localhost:${info.port}`)
    console.log(`Health check: http://localhost:${info.port}/health`)
  },
)