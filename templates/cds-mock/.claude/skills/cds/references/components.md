# 컴포넌트 카탈로그·사용 패턴

## 소스 직독이 1차 소스

소스 퍼블리시라 정확한 props·variant·서브컴포넌트는 항상 소스에서 확인:

```
node_modules/@colosseumcoinckr/cds/src/components/<name>.tsx
```

각 컴포넌트 상단의 타입 정의(`XxxProps`)와 cva `variants` 블록을 읽으면 전체 API가 나온다.
렌더·상호작용 테스트는 `src/**/__test__`에서 확인한다 (스토리북 미운영 — 테스트가 사용 예시 문서를 겸함).

## import 규칙

```tsx
// 컴포넌트 — 파일명 = 서브패스
import { Dialog, DialogContent, DialogTrigger } from '@colosseumcoinckr/cds/components/dialog';
// 디렉토리 컴포넌트
import { AgGrid } from '@colosseumcoinckr/cds/components/ag-grid';
// 훅·유틸
import { useMobile } from '@colosseumcoinckr/cds/hooks/use-mobile';
import { cn } from '@colosseumcoinckr/cds/lib/utils';
import { useUiMessages } from '@colosseumcoinckr/cds/lib/use-ui-messages';
```

루트 barrel 없음 — `from '@colosseumcoinckr/cds'`는 해석되지 않는다.

## 카탈로그 (76종)

아래는 **컴포넌트 모듈**만 추린 목록이다. `src/components/`의 서브패스 진입점은 총 **82종**이고,
차이 6종은 컴포넌트를 내보내지 않는 헬퍼 모듈이다 — `utils` · `input.shared` ·
`icon.constants` · `sidebar-state` · `time-picker.utils` · `use-date-picker`.
집계·슬롯·변형의 정확한 값은 소스에서 생성되는 [`component-spec.md`](component-spec.md)가 갖는다
(`node scripts/extract-component-spec.mjs --check`가 드리프트를 잡는다).

**폼/입력**: button, button-group, checkbox, checkbox-group, radio, radio-group, input,
input-group, input-otp, textarea, native-select, select, combobox, multi-combobox,
multi-select, switch, slider, toggle, toggle-group, segment, search, upload, field, label

**피커**: calendar, date-picker, date-time-picker, multiple-date-picker, range-picker,
range-time-picker, time-panel, time-picker

**오버레이**: dialog, alert-dialog, sheet, drawer, popover, hover-card, tooltip, context-menu,
dropdown-menu, menubar, command(팔레트), sonner(토스트), toast

**네비게이션**: breadcrumb, navigation-menu, navigation-tree, pagination, sidebar, tabs,
step-navigation, tree

**레이아웃/표시**: card, table, ag-grid(래퍼), accordion, collapsible, resizable, scroll-area,
aspect-ratio, avatar, chip, alert, empty, item, kbd, divider, skeleton, spinner,
progress, timeline, carousel, icon, direction, cds-provider

## 자주 쓰는 패턴

- **아이콘**: `<Icon name="expand_more" size={20} />` — Material Symbols 이름 사용.
폰트는 `<MaterialIconsFont />`(icon.tsx)가 CDN link로 로드 — 보통 CDSProvider 근처에 한 번
- **다국어 문자열**: 컴포넌트 내장 라벨은 CDSProvider locale을 따른다. 직접 쓰려면
`useUiMessages()` / `getUiMessages(locale)`
- **AgGrid**: community 모듈만. 전역 등록이 없는 환경(테스트)은
`modules={[AllCommunityModule]}` prop 또는 `ModuleRegistry.registerModules([AllCommunityModule])`
- **ref**: DOM 엘리먼트를 렌더하는 컴포넌트는 forwardRef라 React 18/19 어디서든 `ref`가 루트
엘리먼트에 붙는다. 다만 **42종은 ref를 받지 않는다**(D1 예외) — Radix의 루트·`Portal`·`Sub`·
컨텍스트 Provider처럼 자기 DOM 노드가 없는 래퍼들이다(`Dialog`·`Popover`·`Select`·`Tooltip`·
`CDSProvider` 등). 이런 컴포넌트에 `ref`를 달면 조용히 무시되므로, ref가 필요하면 실제로
DOM을 렌더하는 자식(`DialogContent`·`PopoverContent` 등)에 달아라. 전체 목록은
[`component-spec.md`](component-spec.md) §5

