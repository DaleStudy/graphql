export const ROUTER_NAMES = ["router-0", "router-1"] as const;

export type RouterName = (typeof ROUTER_NAMES)[number];

export interface RouterStub {
  fetch(request: Request): Promise<Response>;
  health(): Promise<Response>;
  destroy(): Promise<void>;
}

export type RouterStubFactory = (name: RouterName) => RouterStub;

export interface RouterLogger {
  info(message: string, details: Record<string, unknown>): void;
  error(message: string, details: Record<string, unknown>): void;
}

interface RouterPoolOptions {
  primaryTimeoutMs?: number;
  failoverTimeoutMs?: number;
  healthTimeoutMs?: number;
  recoveryTimeoutMs?: number;
  logger?: RouterLogger;
}

export interface ErrorDetails {
  name: string;
  message: string;
  stack?: string;
}

export interface RouterHealthResult {
  name: RouterName;
  healthy: boolean;
  recovered: boolean;
  error?: ErrorDetails;
}

const PRIMARY_TIMEOUT_MS = 30_000;
const FAILOVER_TIMEOUT_MS = 5_000;
const HEALTH_TIMEOUT_MS = 30_000;
const RECOVERY_TIMEOUT_MS = 5_000;
const GRAPHQL_HEALTH_QUERY = JSON.stringify({
  query: "query HealthCheck { __typename }",
});

const defaultLogger: RouterLogger = {
  info(message, details) {
    console.log(message, details);
  },
  error(message, details) {
    console.error(message, details);
  },
};

export class RouterTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "RouterTimeoutError";
  }
}

export function describeError(error: unknown): ErrorDetails {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    name: "UnknownError",
    message: String(error),
  };
}

export function orderRouterNames(
  requestKey: string,
): readonly [RouterName, RouterName] {
  let hash = 0;

  for (const character of requestKey) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }

  return hash % ROUTER_NAMES.length === 0
    ? [ROUTER_NAMES[0], ROUTER_NAMES[1]]
    : [ROUTER_NAMES[1], ROUTER_NAMES[0]];
}

async function runWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RouterTimeoutError(label, timeoutMs));
      controller.abort();
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is being discarded for failover, so cancellation is best effort.
  }
}

function unavailableResponse(errors: ErrorDetails[]): Response {
  return Response.json(
    {
      errors: [
        {
          message: "GraphQL router is temporarily unavailable",
          extensions: {
            code: "ROUTER_UNAVAILABLE",
            attempts: errors.map(({ name, message }) => ({ name, message })),
          },
        },
      ],
    },
    {
      status: 503,
      headers: {
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Origin": "*",
        "Retry-After": "5",
      },
    },
  );
}

export async function fetchFromRouterPool(
  request: Request,
  requestKey: string,
  getRouter: RouterStubFactory,
  options: RouterPoolOptions = {},
): Promise<Response> {
  const logger = options.logger ?? defaultLogger;
  const [primary, secondary] = orderRouterNames(requestKey);
  const attempts = [
    {
      name: primary,
      timeoutMs: options.primaryTimeoutMs ?? PRIMARY_TIMEOUT_MS,
    },
    {
      name: secondary,
      timeoutMs: options.failoverTimeoutMs ?? FAILOVER_TIMEOUT_MS,
    },
  ] as const;
  const errors: ErrorDetails[] = [];

  for (const [index, { name, timeoutMs }] of attempts.entries()) {
    try {
      const response = await runWithTimeout(
        (signal) =>
          getRouter(name).fetch(new Request(request.clone(), { signal })),
        timeoutMs,
        name,
      );

      if (response.status < 500) {
        logger.info("[RouterPool] request succeeded", {
          router: name,
          status: response.status,
          failover: index > 0,
        });
        return response;
      }

      await cancelBody(response);
      throw new Error(`${name} returned HTTP ${response.status}`);
    } catch (error) {
      const details = describeError(error);
      errors.push(details);
      logger.error("[RouterPool] request attempt failed", {
        router: name,
        failover: index > 0,
        error: details,
      });
    }
  }

  return unavailableResponse(errors);
}

function isHealthyGraphqlPayload(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("data" in value)) {
    return false;
  }

  const data = value.data;
  return (
    typeof data === "object" &&
    data !== null &&
    "__typename" in data &&
    data.__typename === "Query"
  );
}

async function probeRouter(
  name: RouterName,
  getRouter: RouterStubFactory,
  timeoutMs: number,
): Promise<void> {
  const router = getRouter(name);
  const healthResponse = await runWithTimeout(
    () => router.health(),
    timeoutMs,
    `${name} Apollo health check`,
  );

  if (!healthResponse.ok) {
    await cancelBody(healthResponse);
    throw new Error(
      `${name} Apollo health check returned HTTP ${healthResponse.status}`,
    );
  }
  await cancelBody(healthResponse);

  const graphqlResponse = await runWithTimeout(
    (signal) =>
      router.fetch(
        new Request("https://router.internal/", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: GRAPHQL_HEALTH_QUERY,
          signal,
        }),
      ),
    timeoutMs,
    `${name} GraphQL health check`,
  );

  if (!graphqlResponse.ok) {
    await cancelBody(graphqlResponse);
    throw new Error(
      `${name} GraphQL health check returned HTTP ${graphqlResponse.status}`,
    );
  }

  const payload: unknown = await graphqlResponse.json();
  if (!isHealthyGraphqlPayload(payload)) {
    throw new Error(`${name} returned an invalid GraphQL health response`);
  }
}

export async function checkRouterHealth(
  name: RouterName,
  getRouter: RouterStubFactory,
  options: RouterPoolOptions = {},
): Promise<RouterHealthResult> {
  try {
    await probeRouter(
      name,
      getRouter,
      options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS,
    );
    return {
      name,
      healthy: true,
      recovered: false,
    };
  } catch (error) {
    return {
      name,
      healthy: false,
      recovered: false,
      error: describeError(error),
    };
  }
}

export async function recoverRouter(
  name: RouterName,
  getRouter: RouterStubFactory,
  options: RouterPoolOptions = {},
): Promise<RouterHealthResult> {
  const logger = options.logger ?? defaultLogger;
  const initial = await checkRouterHealth(name, getRouter, options);

  if (initial.healthy) {
    return initial;
  }

  logger.error("[RouterPool] health check failed; restarting once", {
    router: name,
    error: initial.error,
  });

  try {
    await runWithTimeout(
      () => getRouter(name).destroy(),
      options.recoveryTimeoutMs ?? RECOVERY_TIMEOUT_MS,
      `${name} destroy`,
    );
  } catch (error) {
    logger.error("[RouterPool] destroy failed; retrying health check", {
      router: name,
      error: describeError(error),
    });
  }

  const recovered = await checkRouterHealth(name, getRouter, options);
  if (recovered.healthy) {
    logger.info("[RouterPool] router recovered", {
      router: name,
    });
    return {
      ...recovered,
      recovered: true,
    };
  }

  return recovered;
}
