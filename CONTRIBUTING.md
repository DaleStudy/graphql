# 기여 가이드

## 개발 환경 구성

Rover CLI가 설치되어 있지 않으시다면 설치합니다.

```sh
$ curl -sSL https://rover.apollo.dev/nix/latest | sh
```

`rover config` 명령어를 통해 GraphOS에 인증을 합니다.

```sh
$ rover config auth
```

필요한 환경 변수를 설정합니다.

```sh
export GITHUB_API_TOKEN=<깃허브 API 토큰>
```

`rover dev` 명령어를 통해 개발용 GraphQL 서버를 올립니다.

```sh
$ APOLLO_GRAPH_REF=dalestudy@current \
  rover dev --supergraph-config supergraph.yaml --router-config router.yaml
```

`curl` 명령어로 테스트해봅니다.

```sh
$ curl --request POST \
  --header 'content-type: application/json' \
  --url 'https://dalestudy.fly.dev/' \
  --data '{"query":"query { __typename }"}'
{"data":{"__typename":"Query"}}%
```
