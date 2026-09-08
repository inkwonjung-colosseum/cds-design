---
name: cds
description: 콜로세움 공통 디자인 시스템(@colosseumcoinckr/cds·tokens·icons) 사용 지원 — 신규 도입(설치·인증, 에이전트 실행 절차), 컴포넌트 사용법·카탈로그, 디자인 토큰·다크 테마·브랜드 오버라이드, 트러블슈팅 결정 트리, canary 검증. UI 컴포넌트 추가/수정, "CDS", "디자인 시스템", "공통 컴포넌트", "@colosseumcoinckr" 관련 작업 시 사용.
---
# CDS — 콜로세움 공통 디자인 시스템

`@colosseumcoinckr/cds`(컴포넌트) · `@colosseumcoinckr/tokens`(팔레트 SSOT) ·
`@colosseumcoinckr/icons`(SVG 아이콘)의 사용을 돕는 스킬입니다.

## 먼저: 프로젝트 상태 감지

작업 전에 아래를 확인하고 해당 분기의 레퍼런스를 읽으세요.

1. **cds 설치 여부**: `package.json`(또는 lockfile)에 `@colosseumcoinckr/cds`가 있는가?
  - **없으면** → 신규 도입: [references/getting-started.md](references/getting-started.md)
  - **있으면** → 버전 확인 후 아래로
2. **번들러**: Next.js·Vite 모두 추가 설정 불요 — ESM 번들 배포(번들러 무관)
3. **질문 유형별 라우팅**:

- 컴포넌트 사용법·카탈로그·props → [references/components.md](references/components.md)
- **슬롯(`data-slot`)·변형(cva)·상태(`data-*`/`aria-*`)·서브컴포넌트 전수** →
[references/component-spec.md](references/component-spec.md) (소스에서 생성된 매트릭스)
- 색/토큰/다크 테마/브랜드 오버라이드 → [references/foundations.md](references/foundations.md)
- canary 검증·버전 규율 → [references/release.md](references/release.md)
- **뭔가 안 될 때**(스타일 안 먹음·모듈 해석 실패·401/403·타입 에러·`[cds] ...` 런타임 에러) → [references/doctor-checklist.md](references/doctor-checklist.md) 결정 트리를 순서대로

## 핵심 불변식 (모든 분기 공통)

- **루트 barrel 없음** — 항상 서브패스 import:
`import { Button } from '@colosseumcoinckr/cds/components/button'`
- **소스 퍼블리시** — 컴포넌트 실제 소스가 `node_modules/@colosseumcoinckr/cds/src/`에 있다.
props·variant가 궁금하면 **소스를 직접 읽어라** (문서보다 정확).
예: `node_modules/@colosseumcoinckr/cds/src/components/button.tsx`
- **이 문서에 버전을 적지 않는다** — 이 스킬은 레포 최신 기준이고 앱은 특정 버전에 핀되어 있어
어차피 어긋난다. 버전이 필요하면 앱에 실제로 설치된 값을 읽어라:
`cat node_modules/@colosseumcoinckr/cds/package.json | grep '"version"'`
- **peer**: `react`/`react-dom >=18` + `radix-ui`. ag-grid 컴포넌트 사용 시에만
`ag-grid-community`/`ag-grid-react`/`@ag-grid-community/locale`(전부 v36, community 한정 —
enterprise 미지원)
- **CDSProvider** — locale(ko·en·ja)·theme 컨텍스트. next-intl 등 i18n 라이브러리와 무관:
`import { CDSProvider } from '@colosseumcoinckr/cds/components/cds-provider'`
- **새 컴포넌트를 cds에 기여할 때**: React 18 호환을 위해 `React.forwardRef` 필수(D1 —
Biome 플러그인이 강제), 명명 함수 자기재귀 금지(재귀는 내부 이름을 `*Impl`로 분리)

## 설치 경로 (이 스킬 자체)

- `npx skills add https://github.com/colosseumcoinckr/colo-fe-packages --skill cds` (private 레포 git 인증 전제)
- 또는 이 디렉토리를 소비 레포의 `.claude/skills/cds/`로 복사

