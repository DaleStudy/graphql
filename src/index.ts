import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  ROUTER: DurableObjectNamespace<RouterContainer>;
  APOLLO_GRAPH_REF: string;
  APOLLO_KEY: string;
  GITHUB_API_TOKEN: string;
}

export class RouterContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "30m";
  enableInternet = true; // Apollo Uplink과 GitHub subgraph로의 아웃바운드 통신에 필요

  // Worker에 바인딩된 시크릿을 컨테이너 환경 변수로 전달
  // (필드 초기화는 super() 이후 실행되므로 this.env 접근 가능)
  envVars = {
    APOLLO_GRAPH_REF: this.env.APOLLO_GRAPH_REF,
    APOLLO_KEY: this.env.APOLLO_KEY,
    GITHUB_API_TOKEN: this.env.GITHUB_API_TOKEN,
  };
}

export default {
  // 이름 생략 시 단일 인스턴스로 라우팅되며, .fetch()가 컨테이너를 자동 기동한다
  fetch(request: Request, env: Env) {
    return getContainer(env.ROUTER).fetch(request);
  },
};
