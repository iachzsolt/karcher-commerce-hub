import {
  app,
  initializeCommerceHubRuntime,
  runDailyMaintenance,
  runHourlyScheduler,
  runMinuteScheduler,
} from './index.js'

function isCronEnabled() {
  return (
    process.env.COMMERCE_HUB_DENO_CRON_ENABLED
      ?.trim()
      .toLowerCase() === 'true'
  )
}

async function runCronJob(
  name: string,
  job: () => Promise<void>,
) {
  if (!isCronEnabled()) {
    console.log(
      `Skipping ${name}: Deno cron is disabled`,
    )
    return
  }

  await initializeCommerceHubRuntime()
  await job()
}

Deno.cron(
  'commerce-hub-daily-scheduler',
  '40 15 * * 1-5',
  { timezone: 'Europe/Budapest' },
  () => runCronJob(
    'daily scheduler',
    runMinuteScheduler,
  ),
)

Deno.cron(
  'commerce-hub-catalog-sync',
  '0 9,13,17 * * *',
  { timezone: 'Europe/Budapest' },
  () => runCronJob(
    'catalog sync',
    runHourlyScheduler,
  ),
)

Deno.cron(
  'commerce-hub-daily-maintenance',
  '0 2 * * *',
  () => runCronJob(
    'daily maintenance',
    runDailyMaintenance,
  ),
)

await initializeCommerceHubRuntime()

Deno.serve(app.fetch)
