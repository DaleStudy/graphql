[![Apollo Check](https://github.com/DaleStudy/graphql/actions/workflows/apollo-check.yml/badge.svg)](https://github.com/DaleStudy/graphql/actions/workflows/apollo-check.yml)
[![Apollo Publish](https://github.com/DaleStudy/graphql/actions/workflows/apollo-publish.yml/badge.svg)](https://github.com/DaleStudy/graphql/actions/workflows/apollo-publish.yml)

# GraphQL API

🧑‍🚀 달레 스터디의 GraphQL API

## 운영 안정성

- 프로덕션 엔드포인트: <https://graphql.daleseo.workers.dev/>
- 상태 확인: <https://graphql.daleseo.workers.dev/health>
- `router-0`, `router-1` 두 Apollo Router 컨테이너에 요청을 분산하고, 한쪽이 타임아웃 또는 5xx를 반환하면 다른 쪽으로 한 번 전환합니다.
- 10분마다 두 라우터의 Apollo 상태 포트와 실제 GraphQL 쿼리를 확인하며, 실패한 라우터는 한 번 재시작한 뒤 다시 확인합니다.
- 컨테이너는 2개를 사용하고 `max_instances = 3`으로 설정해 배포 중 이전 인스턴스가 내려갈 때 필요한 교체 여유 슬롯을 확보합니다.
- `main` 배포 전 타입 검사와 테스트를 실행하고, 배포 후 실제 GraphQL 쿼리로 스모크 테스트합니다.
