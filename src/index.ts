import {
  Container,
  getContainer,
  type StopParams,
} from "@cloudflare/containers";
import {
  ROUTER_NAMES,
  checkRouterHealth,
  describeError,
  fetchFromRouterPool,
  recoverRouter,
  type RouterStubFactory,
} from "./router-pool";

interface Env {
  ROUTER: DurableObjectNamespace<RouterContainer>;
  APOLLO_GRAPH_REF: string;
  APOLLO_KEY: string;
  GITHUB_API_TOKEN: string;
}

function createRouterFactory(env: Env): RouterStubFactory {
  return (name) => getContainer(env.ROUTER, name);
}

export class RouterContainer extends Container<Env> {
  defaultPort = 8080;
  requiredPorts = [8080, 8088];
  sleepAfter = "30m";
  enableInternet = true; // Apollo Uplink과 GitHub subgraph로의 아웃바운드 통신에 필요

  // Worker에 바인딩된 시크릿을 컨테이너 환경 변수로 전달
  // (필드 초기화는 super() 이후 실행되므로 this.env 접근 가능)
  envVars = {
    APOLLO_GRAPH_REF: this.env.APOLLO_GRAPH_REF,
    APOLLO_KEY: this.env.APOLLO_KEY,
    GITHUB_API_TOKEN: this.env.GITHUB_API_TOKEN,
  };

  health(): Promise<Response> {
    return this.containerFetch(
      "http://localhost/health",
      {
        method: "GET",
      },
      8088,
    );
  }

  onStart(): void {
    console.log("[RouterContainer] started", {
      port: this.defaultPort,
    });
  }

  onStop({ exitCode, reason }: StopParams): void {
    console.log("[RouterContainer] stopped", {
      exitCode,
      reason,
    });
  }

  onError(error: unknown): never {
    console.error("[RouterContainer] failed", describeError(error));
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const requestDetails = {
      method: request.method,
      pathname: url.pathname,
      ray: request.headers.get("cf-ray"),
    };
    const getRouter = createRouterFactory(env);

    if (request.method === "GET" && url.pathname === "/health") {
      const routers = await Promise.all(
        ROUTER_NAMES.map((name) => checkRouterHealth(name, getRouter)),
      );
      const healthy = routers.every((router) => router.healthy);

      return Response.json(
        {
          status: healthy ? "healthy" : "degraded",
          routers,
        },
        {
          status: healthy ? 200 : 503,
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    }

    console.log("[Worker] forwarding request to Router pool", requestDetails);

    try {
      const requestKey = requestDetails.ray ?? crypto.randomUUID();
      const response = await fetchFromRouterPool(
        request,
        requestKey,
        getRouter,
      );

      console.log("[Worker] Router pool responded", {
        ...requestDetails,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });

      return response;
    } catch (error) {
      console.error("[Worker] Router pool request failed", {
        ...requestDetails,
        durationMs: Date.now() - startedAt,
        error: describeError(error),
      });
      throw error;
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const getRouter = createRouterFactory(env);
    const routers = await Promise.all(
      ROUTER_NAMES.map((name) => recoverRouter(name, getRouter)),
    );

    console.log("[Worker] scheduled Router health check completed", {
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
      routers,
    });

    const unavailable = routers.filter((router) => !router.healthy);
    if (unavailable.length > 0) {
      throw new Error(
        `Router health check failed: ${unavailable
          .map((router) => router.name)
          .join(", ")}`,
      );
    }
  },
};
