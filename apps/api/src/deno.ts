import {
  and,
  eq,
} from 'drizzle-orm'
import {
  createDatabase,
  dataConnectionSchedules,
  dataConnections,
} from '@karcher-commerce-hub/database'
import {
  app,
  initializeCommerceHubRuntime,
  runDailyMaintenance,
  runMinuteScheduler,
} from './index.js'

/*
 * Budapest nyári (CEST, UTC+2) és téli (CET, UTC+1) óráeltolása.
 *
 * A Deno Deploy a cron-szabályokat UTC-ben értékeli (a timezone opciót
 * figyelmen kívül hagyja), ezért minden beállított helyi időpontra két
 * cron fut: a nyári és a téli eltolással számolt UTC időpontban. A kettő
 * közül a pontos időt az adatbázis due-ellenőrzése (nextRunAt a beállított
 * timeZone szerint számítva) dönti el; a másik felébresztés nem csinál
 * semmit. Az időpont-változtatás a következő deploy után él.
 */
const BUDAPEST_UTC_OFFSET_HOURS = [1, 2]

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

function dailyTimesToCronPatterns(
  dailyTimesJson: string,
): string[] {
  let dailyTimes: string[] = []

  try {
    const parsed = JSON.parse(
      dailyTimesJson,
    )

    if (Array.isArray(parsed)) {
      dailyTimes = parsed.filter(
        (value): value is string =>
          typeof value === 'string',
      )
    }
  } catch {
    dailyTimes = []
  }

  const patterns = new Set<string>()

  for (const time of dailyTimes) {
    const match =
      /^(\d{1,2}):(\d{2})$/.exec(
        time.trim(),
      )

    if (!match) {
      continue
    }

    const hour = Number(match[1])
    const minute = Number(match[2])

    if (hour > 23 || minute > 59) {
      continue
    }

    for (const offset of BUDAPEST_UTC_OFFSET_HOURS) {
      const utcHour =
        ((hour - offset) % 24 + 24) %
        24

      patterns.add(
        `${minute} ${utcHour} * * *`,
      )
    }
  }

  return [...patterns]
}

function registerDailySchedulerCron(
  pattern: string,
) {
  Deno.cron(
    `commerce-hub-daily-scheduler-${pattern.replace(/[^0-9]/g, '')}`,
    pattern,
    () => runCronJob(
      `daily scheduler (${pattern})`,
      runMinuteScheduler,
    ),
  )
}

function registerFallbackDailyScheduler() {
  console.error(
    'Registering fallback daily scheduler crons: data connection schedules unavailable',
  )

  for (const pattern of dailyTimesToCronPatterns('["15:40"]')) {
    registerDailySchedulerCron(pattern)
  }
}

async function registerDataConnectionSchedulerCrons() {
  const databaseUrl =
    process.env.DATABASE_URL

  if (!databaseUrl) {
    registerFallbackDailyScheduler()
    return
  }

  try {
    const db =
      createDatabase(databaseUrl)

    const schedules =
      await db
        .select({
          dailyTimesJson:
            dataConnectionSchedules
              .dailyTimesJson,
        })
        .from(
          dataConnectionSchedules,
        )
        .innerJoin(
          dataConnections,
          eq(
            dataConnectionSchedules.connectionId,
            dataConnections.id,
          ),
        )
        .where(
          and(
            eq(
              dataConnections.purpose,
              'INVENTORY',
            ),
            eq(
              dataConnectionSchedules.enabled,
              true,
            ),
          ),
        )

    const patterns =
      new Set<string>()

    for (const schedule of schedules) {
      for (const pattern of dailyTimesToCronPatterns(
        schedule.dailyTimesJson,
      )) {
        patterns.add(pattern)
      }
    }

    if (patterns.size === 0) {
      registerFallbackDailyScheduler()
      return
    }

    for (const pattern of patterns) {
      registerDailySchedulerCron(
        pattern,
      )
    }
  } catch (error) {
    console.error(
      'Failed to read data connection schedules:',
      error,
    )

    registerFallbackDailyScheduler()
  }
}

await registerDataConnectionSchedulerCrons()

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