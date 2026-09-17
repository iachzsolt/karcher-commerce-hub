const SOURCE_FEED_URL_ENV = 'ARUKERESO_SOURCE_FEED_URL'
const SOURCE_FEED_USERNAME_ENV =
  'ARUKERESO_SOURCE_FEED_USERNAME'
const SOURCE_FEED_PASSWORD_ENV =
  'ARUKERESO_SOURCE_FEED_PASSWORD'
const SOURCE_FEED_TIMEOUT_MS_ENV =
  'ARUKERESO_SOURCE_FEED_TIMEOUT_MS'
const SOURCE_FEED_MAX_BYTES_ENV =
  'ARUKERESO_SOURCE_FEED_MAX_BYTES'
const SOURCE_FEED_MAX_ATTEMPTS_ENV =
  'ARUKERESO_SOURCE_FEED_MAX_ATTEMPTS'
const SOURCE_FEED_REFRESH_TIME_ENV =
  'ARUKERESO_SOURCE_FEED_REFRESH_TIME'

const SOURCE_FEED_TIMEOUT_MS_DEFAULT = 30_000
const SOURCE_FEED_MAX_BYTES_DEFAULT = 25 * 1024 * 1024
const SOURCE_FEED_MAX_ATTEMPTS_DEFAULT = 3
export const SOURCE_FEED_REFRESH_TIME_DEFAULT = '06:45'
export const SOURCE_FEED_TIME_ZONE = 'Europe/Budapest'

export type SourceFeedRefreshFailureCode =
  | 'FAILED_CONFIGURATION'
  | 'FAILED_DOWNLOAD'
  | 'FAILED_VALIDATION'
  | 'FAILED_SAFETY_GUARD'
  | 'FAILED_IMPORT'
  | 'REFRESH_BUSY'

export class SourceFeedRefreshError extends Error {
  constructor(
    readonly code: SourceFeedRefreshFailureCode,
    message: string,
    readonly httpStatus = 500,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SourceFeedRefreshError'
  }
}

type SourceFeedEnvironment = Record<
  string,
  string | undefined
>

function readPositiveInteger(
  environment: SourceFeedEnvironment,
  name: string,
  fallback: number,
) {
  const raw = environment[name]?.trim()

  if (!raw) {
    return fallback
  }

  const value = Number(raw)

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SourceFeedRefreshError(
      'FAILED_CONFIGURATION',
      `Az ${name} beállítása érvénytelen.`,
      503,
    )
  }

  return value
}

export function resolveSourceFeedConfiguration(
  environment: SourceFeedEnvironment = process.env,
) {
  const url = environment[SOURCE_FEED_URL_ENV]?.trim()
  const username =
    environment[SOURCE_FEED_USERNAME_ENV]?.trim()
  const password =
    environment[SOURCE_FEED_PASSWORD_ENV]

  if (!url || !username || !password) {
    throw new SourceFeedRefreshError(
      'FAILED_CONFIGURATION',
      'Az Árukereső source feed távoli elérése nincs teljesen konfigurálva.',
      503,
    )
  }

  let parsedUrl: URL

  try {
    parsedUrl = new URL(url)
  } catch {
    throw new SourceFeedRefreshError(
      'FAILED_CONFIGURATION',
      'Az Árukereső source feed URL beállítása érvénytelen.',
      503,
    )
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new SourceFeedRefreshError(
      'FAILED_CONFIGURATION',
      'Az Árukereső source feed csak HTTPS kapcsolaton tölthető le.',
      503,
    )
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new SourceFeedRefreshError(
      'FAILED_CONFIGURATION',
      'Az Árukereső source feed URL nem tartalmazhat beágyazott hitelesítési adatot.',
      503,
    )
  }

  return {
    url: parsedUrl.toString(),
    username,
    password,
    timeoutMs: readPositiveInteger(
      environment,
      SOURCE_FEED_TIMEOUT_MS_ENV,
      SOURCE_FEED_TIMEOUT_MS_DEFAULT,
    ),
    maxBytes: readPositiveInteger(
      environment,
      SOURCE_FEED_MAX_BYTES_ENV,
      SOURCE_FEED_MAX_BYTES_DEFAULT,
    ),
    maxAttempts: readPositiveInteger(
      environment,
      SOURCE_FEED_MAX_ATTEMPTS_ENV,
      SOURCE_FEED_MAX_ATTEMPTS_DEFAULT,
    ),
  }
}

function isAcceptedCsvContentType(contentType: string) {
  const mediaType = contentType
    .split(';', 1)[0]
    ?.trim()
    .toLowerCase()

  return (
    mediaType === 'text/csv' ||
    mediaType === 'application/csv' ||
    mediaType === 'text/plain' ||
    mediaType === 'application/octet-stream'
  )
}

function isTransientStatus(status: number) {
  return (
    status === 408 ||
    status === 429 ||
    status >= 500
  )
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
) {
  const contentLength = Number(
    response.headers.get('content-length'),
  )

  if (
    Number.isFinite(contentLength) &&
    contentLength > maxBytes
  ) {
    throw new SourceFeedRefreshError(
      'FAILED_DOWNLOAD',
      'A távoli source feed mérete meghaladja a biztonsági korlátot.',
      502,
    )
  }

  if (!response.body) {
    throw new SourceFeedRefreshError(
      'FAILED_DOWNLOAD',
      'A távoli source feed válasza üres.',
      502,
    )
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const chunk = await reader.read()

      if (chunk.done) {
        break
      }

      totalBytes += chunk.value.byteLength

      if (totalBytes > maxBytes) {
        await reader.cancel()
        throw new SourceFeedRefreshError(
          'FAILED_DOWNLOAD',
          'A távoli source feed mérete meghaladja a biztonsági korlátot.',
          502,
        )
      }

      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }

  if (totalBytes === 0) {
    throw new SourceFeedRefreshError(
      'FAILED_DOWNLOAD',
      'A távoli source feed válasza üres.',
      502,
    )
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0

  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    return new TextDecoder('utf-8', {
      fatal: true,
    }).decode(bytes)
  } catch {
    throw new SourceFeedRefreshError(
      'FAILED_DOWNLOAD',
      'A távoli source feed nem érvényes UTF-8 szöveg.',
      502,
    )
  }
}

export async function downloadArukeresoSourceFeed(input?: {
  environment?: SourceFeedEnvironment
  fetchImplementation?: typeof fetch
  retryDelay?: (milliseconds: number) => Promise<void>
}) {
  const configuration = resolveSourceFeedConfiguration(
    input?.environment,
  )
  const fetchImplementation =
    input?.fetchImplementation ?? fetch
  const retryDelay =
    input?.retryDelay ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds)
      }))
  const authorization = `Basic ${Buffer.from(
    `${configuration.username}:${configuration.password}`,
    'utf8',
  ).toString('base64')}`

  if (configuration.maxAttempts > 5) {
    throw new SourceFeedRefreshError(
      'FAILED_CONFIGURATION',
      `Az ${SOURCE_FEED_MAX_ATTEMPTS_ENV} legfeljebb 5 lehet.`,
      503,
    )
  }

  for (
    let attempt = 1;
    attempt <= configuration.maxAttempts;
    attempt += 1
  ) {
    try {
      const response = await fetchImplementation(
        configuration.url,
        {
          method: 'GET',
          headers: {
            Accept: 'text/csv',
            Authorization: authorization,
          },
          redirect: 'manual',
          signal: AbortSignal.timeout(
            configuration.timeoutMs,
          ),
        },
      )

      if (!response.ok) {
        if (
          isTransientStatus(response.status) &&
          attempt < configuration.maxAttempts
        ) {
          await retryDelay(attempt * 500)
          continue
        }

        throw new SourceFeedRefreshError(
          'FAILED_DOWNLOAD',
          `A távoli source feed letöltése HTTP ${response.status} státusszal sikertelen.`,
          502,
        )
      }

      const contentType =
        response.headers.get('content-type') ?? ''

      if (!isAcceptedCsvContentType(contentType)) {
        throw new SourceFeedRefreshError(
          'FAILED_DOWNLOAD',
          'A távoli source feed válaszának tartalomtípusa nem CSV.',
          502,
        )
      }

      return await readBoundedResponse(
        response,
        configuration.maxBytes,
      )
    } catch (error) {
      if (error instanceof SourceFeedRefreshError) {
        throw error
      }

      if (attempt < configuration.maxAttempts) {
        await retryDelay(attempt * 500)
        continue
      }

      throw new SourceFeedRefreshError(
        'FAILED_DOWNLOAD',
        'A távoli source feed letöltése hálózati hiba vagy időtúllépés miatt sikertelen.',
        502,
      )
    }
  }

  throw new SourceFeedRefreshError(
    'FAILED_DOWNLOAD',
    'A távoli source feed letöltése sikertelen.',
    502,
  )
}

export function getSourceFeedRefreshTime(
  environment: SourceFeedEnvironment = process.env,
) {
  const value =
    environment[SOURCE_FEED_REFRESH_TIME_ENV]?.trim() ||
    SOURCE_FEED_REFRESH_TIME_DEFAULT

  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new SourceFeedRefreshError(
      'FAILED_CONFIGURATION',
      `Az ${SOURCE_FEED_REFRESH_TIME_ENV} beállítása érvénytelen.`,
      503,
    )
  }

  return value
}

export function getBudapestCalendarMinute(now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SOURCE_FEED_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''

  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`,
  }
}

export function shouldRunScheduledSourceFeedRefresh(
  now: Date,
  environment: SourceFeedEnvironment = process.env,
) {
  const calendarMinute = getBudapestCalendarMinute(now)
  const [currentHour, currentMinute] =
    calendarMinute.time.split(':').map(Number)
  const [targetHour, targetMinute] =
    getSourceFeedRefreshTime(environment)
      .split(':')
      .map(Number)
  const elapsedMinutes =
    (currentHour * 60 +
      currentMinute -
      (targetHour * 60 + targetMinute) +
      24 * 60) %
    (24 * 60)

  return {
    // The grace window tolerates cold starts, delayed cron delivery,
    // and a configured local time skipped by the spring DST jump.
    shouldRun: elapsedMinutes <= 120,
    ...calendarMinute,
  }
}

export function getSourceFeedUtcCronPatterns(
  environment: SourceFeedEnvironment = process.env,
) {
  const [hour, minute] = getSourceFeedRefreshTime(environment)
    .split(':')
    .map(Number)
  const utcHours = new Set([
    ((hour - 2) % 24 + 24) % 24,
    ((hour - 1) % 24 + 24) % 24,
    hour,
  ])

  return [...utcHours]
    .sort((left, right) => left - right)
    .map((utcHour) => `${minute} ${utcHour} * * *`)
}

export async function coordinateScheduledSourceFeedRefresh<T>(input: {
  now: Date
  environment?: SourceFeedEnvironment
  hasSuccessfulDailyRefresh: (
    schedule: ReturnType<
      typeof shouldRunScheduledSourceFeedRefresh
    >,
  ) => Promise<boolean>
  withExecutionLock: (
    action: (
      assertOwned: () => Promise<void>,
    ) => Promise<{
      status: 'SUCCESS' | 'ALREADY_SUCCESSFUL'
      result?: T
    }>,
  ) => Promise<{
    status: 'SUCCESS' | 'ALREADY_SUCCESSFUL'
    result?: T
  }>
  refresh: (
    schedule: ReturnType<
      typeof shouldRunScheduledSourceFeedRefresh
    >,
  ) => Promise<T>
  markDailyRefreshSuccessful: (
    schedule: ReturnType<
      typeof shouldRunScheduledSourceFeedRefresh
    >,
  ) => Promise<void>
}) {
  const schedule = shouldRunScheduledSourceFeedRefresh(
    input.now,
    input.environment,
  )

  if (!schedule.shouldRun) {
    return {
      status: 'INELIGIBLE' as const,
      schedule,
    }
  }

  if (await input.hasSuccessfulDailyRefresh(schedule)) {
    return {
      status: 'ALREADY_SUCCESSFUL' as const,
      schedule,
    }
  }

  const execution = await input.withExecutionLock(async (assertOwned) => {
    await assertOwned()

    if (await input.hasSuccessfulDailyRefresh(schedule)) {
      return { status: 'ALREADY_SUCCESSFUL' as const }
    }

    const result = await input.refresh(schedule)
    await assertOwned()
    await input.markDailyRefreshSuccessful(schedule)

    return {
      status: 'SUCCESS' as const,
      result,
    }
  })

  return {
    ...execution,
    schedule,
  }
}
