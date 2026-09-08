# 토큰·다크 테마·브랜드 오버라이드

## 토큰 2계층 구조

| 계층 | 위치 | 내용 |
|---|---|---|
| **팔레트 204종** | `@colosseumcoinckr/tokens` | Figma WEB_CDS-2.0 동기 SSOT — `--color-clblue-*`·`--color-gray-*`·`--color-red-*`·`--color-natural-*` 스케일 + `--color-primary-cb1~3` 별칭. `@theme` 블록 |
| **semantic 87종** | `@colosseumcoinckr/cds/globals.css` | shadcn 계열 변수(`--primary`·`--muted`·`--background-*`·`--text-*`·`--borders-*`)가 팔레트를 참조. `@theme` + `@theme inline` + `:root` 3블록 |

tokens 산출물:
- `@colosseumcoinckr/tokens/tailwind.css` — `@theme` (Tailwind 파이프라인용, cds globals.css가 import)
- `@colosseumcoinckr/tokens/css` — vanilla `:root` (비Tailwind 소비처: 이메일·정적 페이지)
- SSOT는 `tokens/cds-colors.json` — 값 수정은 Figma 변경 → JSON PR → 생성 스크립트

## 오버라이드 규칙 — `@theme` inline 여부로 갈린다 (중요)

cds semantic 변수는 두 종류라 **덮는 방법이 다르다**:

1. **비-inline `@theme` 변수** (팔레트 204 전부 + semantic 일부):
   유틸리티가 `var(--color-x)`를 참조하므로 **`--color-*`를 스코프에서 덮으면 적용**된다.
   ```css
   .my-scope { --color-text-primary: var(--color-white); }
   ```
2. **`@theme inline` 변수** (`--color-background: var(--background)` 형태 —
   background·foreground·primary·muted·sidebar-* 등):
   유틸리티에 **원본 변수가 인라인**되므로 `--color-*`가 아니라 **원본 var를 덮어야** 적용된다.
   ```css
   .my-scope { --primary: rgb(255 255 255 / 0.2); --primary-foreground: var(--color-white); }
   ```

어느 쪽인지 헷갈리면 `node_modules/@colosseumcoinckr/cds/src/styles/globals.css`에서 해당
변수가 `@theme` 블록에 있는지 `@theme inline` 블록에 있는지 확인하라 — 그 파일이 판정 근거다.

## 안정성 등급 — 무엇을 덮어도 안전한가

오버라이드가 **가능**한 것과 **안정적**인 것은 다르다. 등급을 지키지 않으면 minor 업그레이드에서
스타일이 조용히 깨진다.

| 등급 | 대상 | 약속 |
|---|---|---|
| **stable — 지원되는 오버라이드 채널** | tokens 팔레트 `--color-*` 204종(`@colosseumcoinckr/tokens`, Figma WEB_CDS-2.0 SSOT) | 이름·의미가 유지된다. 값은 Figma 변경에 따라 바뀔 수 있다. **브랜드·스코프 오버라이드는 이 계층에서 하라** |
| **unstable — 내부 구현** | cds semantic 중간 변수 — `--background`·`--foreground`·`--primary`·`--muted`·`--sidebar*`·`--chart-*` 등 `@theme inline`의 원본 var | shadcn 계열에서 승계한 배선이라 **이름·구조가 minor에서 바뀔 수 있다.** 덮어야 적용되는 경우가 있지만(위 규칙 2) 업그레이드 시 재확인이 필요하다 |
| **없음 — 컴포넌트 전용 채널** | 컴포넌트별 `--cds-*` 같은 전용 오버라이드 변수 | **의도적으로 노출하지 않는다.** 컴포넌트 외형 조정은 `className`(tailwind-merge) 또는 위 토큰 계층으로 한다 |

실무 지침: **가능하면 stable 계층만 덮어라.** unstable을 덮어야 하는 상황이라면 그 조합을
`className`으로 대체할 수 있는지 먼저 검토하고, 덮을 때는 업그레이드 체크리스트에 남겨라.

> 앱이 소유한 마크업을 cds CSS가 겨냥하는 구조는 만들지 마라 — 계층 역전이다. 과거 cds에
> 사내 시스템별 LNB 색 오버라이드가 있었는데, 대상 마크업이 cds에 없어(위젯 계층 미이식)
> 적용될 수 없는 고아 CSS였고 제거됐다. 앱 위젯의 스코프 오버라이드는 **앱 전역 CSS**에 둔다.

## 다크 테마

- 셀렉터 규약: **`[data-theme="dark"]`** (D3)
- 적용: `<CDSProvider theme="dark">` 또는 앱 스위처가 `document.documentElement.dataset.theme` 설정
- CSS: `@import '@colosseumcoinckr/cds/themes/dark.css'` (cds 재수출 wrapper — SSOT는 tokens)
- 다크 값 세트는 Figma WEB_CDS-2.0 다크 변수 확정에 따라 채워진다 — 값이 비어 있어도
  import는 무해하고, 값 추가는 non-breaking
