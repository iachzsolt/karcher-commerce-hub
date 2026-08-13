import { serve } from '@hono/node-server'
import {
  app,
  initializeCommerceHubRuntime,
  runDailyMaintenance,
  runHourlyScheduler,
  runMinuteScheduler,
  runSixHourlyScheduler,
  schedulerIntervals,
} from './index.js'

function getPort() {
  const port = Number.parseInt(
    process.env.PORT ?? '3000',
    10,
  )

  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error(
      'PORT must be an integer between 1 and 65535',
    )
  }

  return port
}

function startScheduler(
  interval: number,
  job: () => Promise<void>,
) {
  const timer = setInterval(() => {
    void job()
  }, interval)

  timer.unref()
}

async function startServer() {
  await initializeCommerceHubRuntime()

  const schedulersEnabled =
    process.env.COMMERCE_HUB_SCHEDULERS_ENABLED
      ?.trim()
      .toLowerCase() === 'true'

  if (schedulersEnabled) {
    startScheduler(
      schedulerIntervals.minute,
      runMinuteScheduler,
    )
    startScheduler(
      schedulerIntervals.hourly,
      runHourlyScheduler,
    )
    startScheduler(
      schedulerIntervals.sixHourly,
      runSixHourlyScheduler,
    )
    startScheduler(
      schedulerIntervals.daily,
      runDailyMaintenance,
    )

    void runMinuteScheduler()
    void runHourlyScheduler()
    void runSixHourlyScheduler()
    void runDailyMaintenance()
  } else {
    console.log('Commerce Hub schedulers are disabled')
  }

  const port = getPort()
  const hostname =
    process.env.HOST?.trim() || '0.0.0.0'

  serve(
    {
      fetch: app.fetch,
      port,
      hostname,
    },
    (info) => {
      console.log(
        `Commerce Hub API: http://localhost:${info.port}`,
      )
      console.log(
        `Health check: http://localhost:${info.port}/health`,
      )
    },
  )
}

void startServer()
