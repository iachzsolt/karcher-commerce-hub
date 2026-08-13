import {
  app,
  initializeCommerceHubRuntime,
  runDailyMaintenance,
  runHourlyScheduler,
  runMinuteScheduler,
  runSixHourlyScheduler,
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
  'commerce-hub-minute-scheduler',
  '* * * * *',
  () => runCronJob(
    'minute scheduler',
    runMinuteScheduler,
  ),
)

Deno.cron(
  'commerce-hub-hourly-scheduler',
  '0 * * * *',
  () => runCronJob(
    'hourly scheduler',
    runHourlyScheduler,
  ),
)

Deno.cron(
  'commerce-hub-six-hour-scheduler',
  '0 */6 * * *',
  () => runCronJob(
    'six-hour scheduler',
    runSixHourlyScheduler,
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
