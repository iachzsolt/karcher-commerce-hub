declare const Deno: {
  cron(
    name: string,
    schedule: string,
    handler: () => void | Promise<void>,
  ): void
  cron(
    name: string,
    schedule: string,
    options: {
      backoffSchedule?: number[]
      timezone?: string
    },
    handler: () => void | Promise<void>,
  ): void
  serve(
    handler: (
      request: Request,
    ) => Response | Promise<Response>,
  ): unknown
}
