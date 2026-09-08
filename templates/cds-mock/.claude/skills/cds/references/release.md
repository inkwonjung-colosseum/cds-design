# canary 검증·버전 규율

## canary — 머지 전 실검증

colo-fe-packages PR에 **`canary` 라벨**을 붙이면 CI가 snapshot 버전을 `@canary` dist-tag로
퍼블리시하고 PR 코멘트로 버전을 알려준다. 소비 레포에서:

```bash
pnpm add @colosseumcoinckr/cds@canary
```

검증 후 정식 버전으로 되돌리는 것 잊지 말 것. changeset이 없는 PR은 퍼블리시가 스킵된다.

## 소비 앱에서 확인하기

소비 앱에서 cds 변경을 확인하려면 **배포된 패키지**를 설치합니다 — 로컬 `link:`/`overrides`는 로컬
빌드 상태에 좌우되고 퍼블리시 산출물(`files` 필터·exports 해석)을 검증하지 못하므로 쓰지 않습니다.

- **배포판 설치**: `pnpm add @colosseumcoinckr/cds`
- **canary snapshot 설치** (머지 전): PR에 `canary` 라벨을 붙이면 snapshot 버전을 설치할 수 있습니다.
  `pnpm add @colosseumcoinckr/cds@canary`

상세는 [CONTRIBUTING.md](../../../CONTRIBUTING.md)를 참고하세요.

## 버전 규율 (0.x)

- breaking change(컴포넌트/서브패스 제거·rename, props 계약 축소, peer 상향)는 **minor**
- 기능 추가 minor / 버그 수정 patch
- cds 1.0.0 승격 기준: 최대 소비자 앱이 실사용 중(P3 완료)

## cds에 기여할 때 체크리스트

1. changeset 포함 (`pnpm changeset`)
2. 컴포넌트 변경 시 `src/**/__test__` 렌더·상호작용 테스트 추가·갱신 (스토리북 미운영 — 테스트가 사용 예시 문서를 겸함)
3. **breaking change면 이 스킬(`skills/cds/`)을 함께 갱신** — 스킬이 낡으면 AI가 낡은 API를
   재생산한다 (P5 유지 규율, PR 템플릿 체크 항목)
4. forwardRef 필수(D1) — Biome 플러그인이 lint에서 강제, `forward-ref-contract.test.ts`가 이중 검증
