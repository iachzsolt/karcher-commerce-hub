type PagesFunction<
  Env = unknown,
  Params extends string = string,
> = (context: {
  request: Request
  env: Env
  params: Record<Params, string | string[]>
}) => Response | Promise<Response>
