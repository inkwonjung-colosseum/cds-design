# CDS 신규 도입 — 에이전트 실행 절차

아래 6단계는 **멱등**(이미 완료된 단계는 건너뛰어도 안전)이며, 각 단계에 **확인 커맨드**가 있다.
전부 통과하면 도입 완료. 중간에 실패하면 해당 단계의 "실패 시" 분기를 따르고,
증상 기반 진단은 [doctor-checklist.md](doctor-checklist.md)를 사용한다.

## 0. 사전 감지 (프레임워크·패키지 매니저·Tailwind)

```bash
ls next.config.* 2>/dev/null && echo FRAMEWORK=next
ls vite.config.* 2>/dev/null && echo FRAMEWORK=vite
ls pnpm-lock.yaml yarn.lock package-lock.json 2>/dev/null
# Tailwind v4 (cds 스타일링 하드 요구 — optional peer라 pnpm이 자동 설치 안 함)
node -e "console.log('tailwindcss', require('tailwindcss/package.json').version)" 2>/dev/null || echo tailwindcss MISSING
```

- `tailwindcss MISSING` 또는 v3 → §3-1 부트스트랩부터 시작한다(신규 Next.js 앱은 기본 포함이 아님).
- Next.js·Vite 모두 추가 번들러 설정 **불필요** — cds는 tsdown ESM 번들 배포.
- 둘 다 아니면: 번들러 환경(ESM 소비 가능)인지 확인 후 진행. CJS `require()` 전용 환경은 미지원(의도된 설계).

## 1. GitHub Packages 인증

레포 루트 `.npmrc`에 registry 매핑이 **있는지 먼저 확인**, 없을 때만 추가:

```bash
grep -q '@colosseumcoinckr:registry' .npmrc 2>/dev/null \
  || echo '@colosseumcoinckr:registry=https://npm.pkg.github.com' >> .npmrc
```

> **토큰을 이 파일에 쓰지 마라.** pnpm 10.34.2+/11은 repo `.npmrc`의 `${ENV_VAR}` 확장을 지원하지 않아
> `${NODE_AUTH_TOKEN}`은 치환되지 않고 인증에 실패한다.

토큰(user-level, `read:packages` 권한 PAT — 사람이 준비해야 하는 유일한 단계):

```bash
pnpm config set //npm.pkg.github.com/:_authToken <PAT>
```

**확인**: `pnpm view @colosseumcoinckr/cds version` 이 버전을 출력하면 통과.
**실패 시**(401/403): user-level 토큰 미등록 또는 권한 부족 — 사람에게 PAT 준비를 요청하고 대기.
CI 환경은 `actions/setup-node`의 `registry-url` + `NODE_AUTH_TOKEN`(=`GITHUB_TOKEN`, `permissions: packages: read`) 조합을 쓴다.

## 2. 설치

```bash
pnpm add @colosseumcoinckr/cds
# ag-grid 컴포넌트(AgGrid)를 쓰는 앱만:
pnpm add ag-grid-community ag-grid-react @ag-grid-community/locale
```

- `react`/`react-dom >=18` 필요. `radix-ui`는 pnpm `autoInstallPeers`(기본 on)가 자동 설치 — 끈 환경에서만 `pnpm add radix-ui`.
- ag-grid는 **community 판 v36 한정**(enterprise 미지원 — D5).

**확인**: `node -e "console.log(require('./package.json').dependencies['@colosseumcoinckr/cds'])"` 값 존재 + `ls node_modules/@colosseumcoinckr/cds/src` 가 소스를 보여주면 통과(소스 동봉 배포).

## 3. CSS 배선

### 3-1. Tailwind v4 + PostCSS (§0에서 `tailwindcss MISSING`면 필수)

cds 클래스는 Tailwind v4 유틸리티로 컴파일된다. `tailwindcss`·`@tailwindcss/postcss`는 **optional peer**라
`pnpm add @colosseumcoinckr/cds`만으로는 설치되지 않는다(pnpm `autoInstallPeers`가 optional peer를
건너뛴다). 신규 Next.js 앱(create-next-app)은 기본 포함이 아니므로 직접 설치한다.

```bash
pnpm add -D tailwindcss@^4 @tailwindcss/postcss@^4
```

PostCSS 설정 파일이 없으면 만든다(Vite가 `@tailwindcss/vite` 플러그인을 쓰면 불필요):

```js
// postcss.config.mjs
const config = { plugins: { '@tailwindcss/postcss': {} } };
export default config;
```

> `@colosseumcoinckr/cds/postcss.config`를 복사해도 같다 — 내용이 동일하다.

**확인**: `pnpm ls tailwindcss @tailwindcss/postcss` 가 둘 다 버전을 출력하면 통과.

### 3-2. 전역 CSS import

앱 전역 CSS 파일(Next: `app/globals.css` 등 / Vite: `src/index.css` 등)을 찾아,
아래 3줄이 **없을 때만** 추가한다(중복 import 금지):

```css
@import 'tailwindcss';
@import '@colosseumcoinckr/cds/globals.css';
@import '@colosseumcoinckr/cds/themes/dark.css'; /* 다크 테마 사용 시에만 */

/* 앱 자기 코드의 유틸 클래스 스캔 — cds 소스는 cds CSS가 자체 @source로 커버하므로 불요 */
@source './src/**/*.{ts,tsx}';
```

- `@import 'tailwindcss'`는 **앱 책임**(이중 적용 방지를 위해 cds가 포함하지 않음) — 3-1이 전제.
- `@source` 글롭은 globals.css 위치 기준 **상대 경로**로 앱 소스를 가리킨다(Next App Router처럼
  globals.css가 `src/app/` 아래면 `'../**/*.{ts,tsx}'`가 된다).

**확인**: 전역 CSS에 `grep -c 'colosseumcoinckr/cds/globals.css' <전역CSS경로>` = 1.

## 4. Provider 어댑터 (root layout, 3줄)

root layout(Next: `app/layout.tsx` / Vite: 엔트리 컴포넌트)에서 자식을 감싼다:

```tsx
import { CDSProvider } from '@colosseumcoinckr/cds/components/cds-provider';

<CDSProvider locale={locale}>{children}</CDSProvider>
```

- `locale`: BCP-47 코드. 미지정 시 문서/브라우저에서 추론. 지원: ko·en·ja(그 외는 en 정규화)
- next-intl을 쓰는 앱이면 `useLocale()` 값을 그대로 — cds는 next-intl에 의존하지 않음

## 5. 스모크 확인

임의 페이지에:

```tsx
import { Button } from '@colosseumcoinckr/cds/components/button';

<Button variant="default" size="medium">확인</Button>
```

**확인 (시각)**: 앱 빌드/렌더 후 버튼에 스타일이 적용되면 도입 완료.
**확인 (기계)**: 렌더된 버튼이 `data-slot="button"` + 비어있지 않은 `class`를 갖고, 컴파일된 CSS에
cds 토큰이 색으로 풀려있으면 토큰→유틸리티→색 파이프라인이 동작하는 것이다. 빌드 산출물에서:
```bash
# Next: .next/static/{css,chunks}/*.css 중 가장 큰 파일 / Vite: dist/assets/*.css
grep -oE '\.bg-background-primary-cb1\{[^}]*\}' <빌드CSS>     # 유틸리티 규칙 존재
grep -oE -- '--color-background-primary-cb1:[^;]*' <빌드CSS>  # var(--color-clblue-500) 로 해석
```
**실패 시**: 스타일 없는 버튼 → [doctor-checklist.md](doctor-checklist.md) §1. import 에러 → §2.

## 6. 도입 후 불변식 (이 앱의 모든 후속 작업에 적용)

- **항상 서브패스 import** — `@colosseumcoinckr/cds/components/<name>`. 루트 barrel은 존재하지 않는다.
- props·variant가 궁금하면 `node_modules/@colosseumcoinckr/cds/src/components/<name>.tsx` **소스를 직접 읽는다**(문서보다 정확).
- 버전 업그레이드·canary 검증은 [release.md](release.md).
