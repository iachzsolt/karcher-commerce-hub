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
  runScheduledArukeresoSourceFeedRefresh,
} from './index.js'
import {
  getSourceFeedUtcCronPatterns,
  isDenoCronEnabled,
} from './arukereso-source-feed.js'
import {
  runAllegroNotifyTick,
  setNotifyKvStore,
  openDenoNotifyKv,
} from './allegro-notify.js'

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
  return isDenoCronEnabled()
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

/*
 * Lightweight wrapper for the Allegro notification tick
 * ONLY. Unlike runCronJob it deliberately skips
 * initializeCommerceHubRuntime(): restoring the primary
 * Allegro session touches Neon (credential read) and the
 * network on first use, which would violate the
 * zero-Neon steady-state requirement of the 10-minute
 * notification tick. The tick authenticates from its own
 * KV-stored OAuth session instead. Do not reuse this for
 * jobs that need the database-backed runtime.
 */
async function runAllegroNotifyCron() {
  if (!isCronEnabled()) {
    console.log(
      'Skipping allegro notify: Deno cron is disabled',
    )
    return
  }

  try {
    const summary = await runAllegroNotifyTick()

    console.log(
      'Allegro notify tick completed:',
      {
        status: summary.status,
        orderEventsSeen: summary.orderEventsSeen,
        orderEmailsSent: summary.orderEmailsSent,
        orderEmailsFailed:
          summary.orderEmailsFailed,
        messagesSeen: summary.messagesSeen,
        messageEmailsSent:
          summary.messageEmailsSent,
        messageEmailsFailed:
          summary.messageEmailsFailed,
      },
    )
  } catch (error) {
    console.error(
      'Allegro notify tick failed:',
      error instanceof Error
        ? error.message
        : 'Unknown error',
    )
  }
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

// Deno Deploy discovers Deno.cron jobs only when they are
// registered at module top level, so this loop is intentionally
// unconditional: the jobs always appear in the Cron dashboard.
// Feature gating lives inside the handler instead — runCronJob
// checks COMMERCE_HUB_DENO_CRON_ENABLED and
// runScheduledArukeresoSourceFeedRefresh checks
// ARUKERESO_SOURCE_FEED_SCHEDULE_ENABLED before doing any work.
for (const pattern of getSourceFeedUtcCronPatterns()) {
  Deno.cron(
    `commerce-hub-arukereso-source-${pattern.replace(/[^0-9]/g, '')}`,
    pattern,
    () =>
      runCronJob(
        `Arukereso source feed refresh (${pattern})`,
        runScheduledArukeresoSourceFeedRefresh,
      ),
  )
}

Deno.cron(
  'commerce-hub-daily-maintenance',
  '0 2 * * *',
  () => runCronJob(
    'daily maintenance',
    runDailyMaintenance,
  ),
)

// Allegro -> email notification bridge: exactly ONE cron
// for order events and buyer messages. Registration is
// unconditional so Deno Deploy discovers it; the handler
// returns early unless ALLEGRO_NOTIFY_ENABLED is true, and
// the tick itself performs zero Neon queries (Deno KV only).
Deno.cron(
  'commerce-hub-allegro-notify',
  '*/10 * * * *',
  () => runAllegroNotifyCron(),
)

setNotifyKvStore(await openDenoNotifyKv())

await initializeCommerceHubRuntime()

Deno.serve(app.fetch)
