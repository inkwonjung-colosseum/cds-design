# CDS 트러블슈팅 결정 트리 (doctor 체크리스트)

소비 앱에서 cds가 기대대로 동작하지 않을 때, 아래를 **순서대로** 검사한다.
각 항목은 결정론 커맨드 + 판정 + 처방으로 구성된다. 전부 통과하면 설정 문제가 아니라
컴포넌트 사용법 문제다 → [components.md](components.md)와 소스를 읽어라.

## §1. 컴포넌트는 뜨는데 스타일이 안 먹는다 (최다 빈도)

```bash
# a) Tailwind v4 + PostCSS 플러그인이 설치됐는가? (optional peer — pnpm 자동 설치 안 함. 신규 Next.js 앱 최다 원인)
pnpm ls tailwindcss @tailwindcss/postcss 2>/dev/null
# b) 전역 CSS에 cds CSS import가 있는가?
grep -rn 'colosseumcoinckr/cds/globals.css' --include='*.css' src app 2>/dev/null
# c) tailwindcss import가 있는가? (cds CSS보다 위에)
grep -rn "@import 'tailwindcss'" --include='*.css' src app 2>/dev/null
# d) @source가 앱 소스를 스캔하는가?
grep -rn '@source' --include='*.css' src app 2>/dev/null
```

| 결과 | 처방 |
|---|---|
| a MISSING | [getting-started §3-1](getting-started.md) 부트스트랩 — `pnpm add -D tailwindcss@^4 @tailwindcss/postcss@^4` |
| PostCSS 설정 누락 | `postcss.config.mjs`에 `@tailwindcss/postcss` 플러그인 추가 — [getting-started §3-1](getting-started.md) |
| b 없음 | `@import '@colosseumcoinckr/cds/globals.css';` 추가 ([getting-started §3-2](getting-started.md)) |
| c 없음 | `@import 'tailwindcss';` 를 cds import **위에** 추가 |
| d 없음/글롭 불일치 | `@source './src/**/*.{ts,tsx}';` 를 globals.css 위치 기준 상대 경로로 추가 |
| 다크만 안 됨 | `themes/dark.css` import 확인 + `<html data-theme="dark">` 속성 확인 ([foundations.md](foundations.md)) |

## §2. 모듈 해석 실패 (Cannot find module / ERR_MODULE_NOT_FOUND)

```bash
# a) 설치돼 있는가?
ls node_modules/@colosseumcoinckr/cds/package.json 2>/dev/null || echo NOT_INSTALLED
# b) 루트 barrel로 import하고 있지 않은가? (불변식 위반 — 루트 barrel 없음)
grep -rn "from '@colosseumcoinckr/cds'" --include='*.ts*' src app 2>/dev/null
# c) require()로 부르고 있지 않은가? (ESM 단일 배포 — 의도된 미지원)
grep -rn "require('@colosseumcoinckr" --include='*.ts*' --include='*.js' src app 2>/dev/null
```

| 결과 | 처방 |
|---|---|
| NOT_INSTALLED | §3 인증 검사 후 `pnpm add @colosseumcoinckr/cds` |
| b 매치 있음 | 서브패스로 교정: `@colosseumcoinckr/cds/components/<name>` |
| c 매치 있음 | ESM import로 교정 — CJS 산출물은 존재하지 않음(Dual Package Hazard 방지 설계) |
| radix-ui 못 찾음 | `pnpm add radix-ui` (autoInstallPeers 꺼진 환경) |

## §3. 설치가 401/403으로 실패한다

```bash
# a) registry 매핑 존재?
grep '@colosseumcoinckr:registry' .npmrc 2>/dev/null || echo NO_MAPPING
# b) repo .npmrc에 env 참조 토큰이 있는가? (pnpm 10.34.2+/11에서 치환 안 됨 — 있으면 제거 대상)
grep '_authToken.*\${' .npmrc 2>/dev/null && echo ENV_TOKEN_IN_REPO_NPMRC
# c) user-level 토큰 등록 여부(값은 출력하지 말 것)
pnpm config get //npm.pkg.github.com/:_authToken | grep -q . && echo USER_TOKEN_SET || echo NO_USER_TOKEN
```

| 결과 | 처방 |
|---|---|
| NO_MAPPING | `.npmrc`에 `@colosseumcoinckr:registry=https://npm.pkg.github.com` 추가 |
| ENV_TOKEN_IN_REPO_NPMRC | 해당 줄 삭제 → user-level로 이전 (아래) |
| NO_USER_TOKEN | **사람 액션**: `read:packages` PAT 준비 후 `pnpm config set //npm.pkg.github.com/:_authToken <PAT>` |

## §4. ag-grid 컴포넌트 에러

```bash
node -e "const p=require('./package.json');['ag-grid-community','ag-grid-react','@ag-grid-community/locale'].forEach(d=>console.log(d, p.dependencies?.[d]??'MISSING'))"
```

- MISSING 있음 → 셋 다 설치(전부 v36, community 한정). enterprise 모듈 import는 미지원(D5).
- 테스트에서만 실패 → `ModuleRegistry.registerModules` 누락 여부 확인(cds 소스의 `__test__` 패턴 참조).

## §5. 타입 에러 (React 18 앱)

- cds는 React 18/19 이중 타입 계약을 유지한다 — `@types/react` 버전이 앱의 react 버전과 일치하는지 확인.
- `forwardRef` 관련 타입 에러가 cds 컴포넌트에서 나면 버전 불일치 가능성 — 설치된 cds 버전과 이 스킬의 기술 버전을 비교하고, 의심되면 `node_modules/@colosseumcoinckr/cds/src` 소스를 직접 확인.

## §6. 버전 드리프트

```bash
pnpm view @colosseumcoinckr/cds version   # 최신 배포판
node -e "console.log(require('./node_modules/@colosseumcoinckr/cds/package.json').version)"  # 설치본
```

- 두 값이 다르면 업그레이드 검토 — 절차와 canary 검증은 [release.md](release.md).

> §6의 `pnpm view`는 레지스트리를 조회하므로 **§3 인증이 통과한 뒤에만** 의미가 있다.
> 401이 나면 버전 문제가 아니라 인증 문제다 → §3으로 돌아가라.

## §7. `[cds] useX must be used within <Y>` 런타임 에러

컨텍스트 가드가 발화한 것이다 — **설정 문제가 아니라 컴포넌트 트리 구조 문제**다.
cds가 던지는 개발자 진단 메시지는 모두 `[cds] ` 접두사를 가진다.

| 메시지 | 처방 |
|---|---|
| `useSidebar must be used within <SidebarProvider>` | 해당 서브트리를 `<SidebarProvider>`로 감싼다 |
| `useCarousel must be used within <Carousel>` | `<Carousel>` 안에서만 훅/하위 컴포넌트를 쓴다 |
| `useTimeline must be used within <Timeline>` | 동일 — `<Timeline>` 하위로 이동 |
| `useStepNavigation(Item) must be used within <StepNavigation(Item)>` | 중첩 순서 확인 — Item 훅은 `<StepNavigationItem>` 하위여야 한다 |
| `<ComboboxX> must be used within <Combobox>` | compound 하위 컴포넌트를 `<Combobox>` 밖에서 렌더하고 있다 |
| `useMultiComboboxContext must be used within <MultiCombobox>` | 동일 — `<MultiCombobox>` 하위로 이동 |
| `SegmentItem icon-only usage requires aria-label` | 아이콘만 있는 `SegmentItem`에 `aria-label`을 준다(접근성 요구) |
| `NavigationTreeItemLabel must be used within <NavigationTreeItem>, or receive an \`item\` prop` | `<NavigationTreeItem>` 하위로 옮기거나 `item`을 직접 넘긴다 |
| `NavigationTreeDragLine requires a tree with dragAndDropFeature registered` | tree 인스턴스에 `dragAndDropFeature`를 등록한다 |

일반 규칙: 메시지의 `<Y>`가 감싸야 할 컴포넌트다. 정확한 트리 요구사항은
`node_modules/@colosseumcoinckr/cds/src/components/<name>.tsx` 소스를 직접 읽어 확인한다
(소스가 배포에 동봉된다 — 문서보다 정확).
