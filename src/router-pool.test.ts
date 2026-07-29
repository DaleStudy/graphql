import { describe, expect, test } from "bun:test";
import {
  ROUTER_NAMES,
  fetchFromRouterPool,
  orderRouterNames,
  recoverRouter,
  type RouterLogger,
  type RouterName,
  type RouterStub,
} from "./router-pool";

const logger: RouterLogger = {
  info() {},
  error() {},
};

function healthyResponse(): Response {
  return Response.json({
    data: {
      __typename: "Query",
    },
  });
}

function createRouterStub(overrides: Partial<RouterStub> = {}): RouterStub {
  return {
    fetch: overrides.fetch ?? (async () => healthyResponse()),
    health:
      overrides.health ??
      (async () => Response.json({ status: "UP" }, { status: 200 })),
    destroy: overrides.destroy ?? (async () => {}),
  };
}

function createFactory(
  routers: Record<RouterName, RouterStub>,
): (name: RouterName) => RouterStub {
  return (name) => routers[name];
}

function createRouterMap(): Record<RouterName, RouterStub> {
  return {
    [ROUTER_NAMES[0]]: createRouterStub(),
    [ROUTER_NAMES[1]]: createRouterStub(),
  };
}

describe("orderRouterNames", () => {
  test("deterministically spreads requests across both routers", () => {
    expect(orderRouterNames("a")).toEqual([ROUTER_NAMES[1], ROUTER_NAMES[0]]);
    expect(orderRouterNames("b")).toEqual([ROUTER_NAMES[0], ROUTER_NAMES[1]]);
    expect(orderRouterNames("a")).toEqual(orderRouterNames("a"));
  });
});

describe("fetchFromRouterPool", () => {
  test("returns the primary response without contacting the secondary", async () => {
    const [primary, secondary] = orderRouterNames("primary-success");
    const calls: RouterName[] = [];
    const routers: Record<RouterName, RouterStub> = {
      [ROUTER_NAMES[0]]: createRouterStub({
        fetch: async () => {
          calls.push(ROUTER_NAMES[0]);
          return healthyResponse();
        },
      }),
      [ROUTER_NAMES[1]]: createRouterStub({
        fetch: async () => {
          calls.push(ROUTER_NAMES[1]);
          return healthyResponse();
        },
      }),
    };

    const response = await fetchFromRouterPool(
      new Request("https://example.com/", {
        method: "POST",
        body: "{}",
      }),
      "primary-success",
      createFactory(routers),
      { logger },
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([primary]);
    expect(calls).not.toContain(secondary);
  });

  test("retries the request body on the secondary after a primary 5xx", async () => {
    const [primary, secondary] = orderRouterNames("failover");
    const bodies: Array<{ name: RouterName; body: string }> = [];
    const routers = createRouterMap();
    routers[primary] = createRouterStub({
      fetch: async (request) => {
        bodies.push({ name: primary, body: await request.text() });
        return new Response("failed", { status: 500 });
      },
    });
    routers[secondary] = createRouterStub({
      fetch: async (request) => {
        bodies.push({ name: secondary, body: await request.text() });
        return healthyResponse();
      },
    });

    const response = await fetchFromRouterPool(
      new Request("https://example.com/", {
        method: "POST",
        body: '{"query":"query { __typename }"}',
      }),
      "failover",
      createFactory(routers),
      { logger },
    );

    expect(response.status).toBe(200);
    expect(bodies).toEqual([
      { name: primary, body: '{"query":"query { __typename }"}' },
      { name: secondary, body: '{"query":"query { __typename }"}' },
    ]);
  });

  test("fails over when the primary exceeds its timeout", async () => {
    const [primary, secondary] = orderRouterNames("timeout");
    const calls: RouterName[] = [];
    const routers = createRouterMap();
    routers[primary] = createRouterStub({
      fetch: async () => {
        calls.push(primary);
        return new Promise<Response>(() => {});
      },
    });
    routers[secondary] = createRouterStub({
      fetch: async () => {
        calls.push(secondary);
        return healthyResponse();
      },
    });

    const response = await fetchFromRouterPool(
      new Request("https://example.com/"),
      "timeout",
      createFactory(routers),
      {
        primaryTimeoutMs: 5,
        failoverTimeoutMs: 20,
        logger,
      },
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual([primary, secondary]);
  });

  test("returns a CORS-safe 503 after both routers fail", async () => {
    const [primary, secondary] = orderRouterNames("all-fail");
    const failedRouter = createRouterStub({
      fetch: async () => new Response("failed", { status: 500 }),
    });
    const routers: Record<RouterName, RouterStub> = {
      [ROUTER_NAMES[0]]: failedRouter,
      [ROUTER_NAMES[1]]: failedRouter,
    };

    const response = await fetchFromRouterPool(
      new Request("https://example.com/"),
      "all-fail",
      createFactory(routers),
      { logger },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Retry-After")).toBe("5");
    const body = await response.text();
    expect(body).toContain('"code":"ROUTER_UNAVAILABLE"');
    expect(body).toContain(`${primary} returned HTTP 500`);
    expect(body).toContain(`${secondary} returned HTTP 500`);
  });
});

describe("recoverRouter", () => {
  test("destroys an unhealthy router once and verifies the replacement", async () => {
    let graphqlChecks = 0;
    let destroyCalls = 0;
    const router = createRouterStub({
      fetch: async () => {
        graphqlChecks += 1;
        return graphqlChecks === 1
          ? new Response("failed", { status: 500 })
          : healthyResponse();
      },
      destroy: async () => {
        destroyCalls += 1;
      },
    });
    const routers: Record<RouterName, RouterStub> = {
      [ROUTER_NAMES[0]]: router,
      [ROUTER_NAMES[1]]: createRouterStub(),
    };

    const result = await recoverRouter(
      ROUTER_NAMES[0],
      createFactory(routers),
      {
        healthTimeoutMs: 20,
        recoveryTimeoutMs: 20,
        logger,
      },
    );

    expect(result).toEqual({
      name: ROUTER_NAMES[0],
      healthy: true,
      recovered: true,
    });
    expect(destroyCalls).toBe(1);
    expect(graphqlChecks).toBe(2);
  });
});
