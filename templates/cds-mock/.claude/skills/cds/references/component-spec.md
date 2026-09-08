<!-- 생성 파일 — 직접 수정 금지. SSOT: packages/cds/src/components/**
     재생성: node scripts/extract-component-spec.mjs
     드리프트 검증: node scripts/extract-component-spec.mjs --check -->

# 슬롯·변형·상태 스펙 매트릭스 (생성 파일)

**이 파일은 소스에서 생성된다. 직접 수정하지 마세요** — 다음 재생성에서 덮어써진다.
소스를 고쳤으면 `node scripts/extract-component-spec.mjs` 로 재생성해 같은 커밋에 넣어라
(`--check` 가 드리프트를 exit 1 로 잡는다).

이 레포는 seed-design 류의 선언적 스펙 빌드 엔진을 **의도적으로 채택하지 않는다**
(단일 웹 플랫폼·소규모 조직에 과잉). 스펙의 SSOT 는 여전히 컴포넌트 소스이고, 이 문서는
그 소스에서 읽기 전용으로 추출한 **조회용 매트릭스**다. 값이 이상하면 문서가 아니라 소스가 정답이다:
`node_modules/@colosseumcoinckr/cds/src/components/<모듈>.tsx`.

## 집계

| 항목 | 수 |
|---|---|
| 모듈(서브패스 진입점) | 83 |
| 컴포넌트 named export | 343 |
| `data-slot` 선언 | 361 |
| `cva()` 선언 | 22 (16 모듈) |
| cva 변형 축 | 31 |
| ref 미수용 컴포넌트 | 42 |

## 읽는 법 (추출 규칙과 한계)

- **모듈 = import 서브패스.** 표의 모듈 `button` 은
  `import { Button } from '@colosseumcoinckr/cds/components/button'` 이다. 루트 barrel 없음.
- **슬롯** = JSX `data-slot='...'` 리터럴 전수. cds 는 이걸로 구조를 표현하고, 소비처는
  `[data-slot="dialog-header"]` 같은 셀렉터로 스타일을 덮거나 테스트에서 조회한다.
  동적 슬롯명(`data-slot={...}`)은 0건이라 이 표가 전수다.
- **변형** = `cva()` 의 `variants` 만. **cva 밖에서 구현된 변형은 §1 에 없다** —
  예를 들어 `dialog` 의 `size` 는 cva 가 아니라 클래스 맵이라 §3 의 `data-size` 값에서
  확인해야 한다. §1 에 없고 §3 에 있으면 그 축은 prop 으로 존재한다고 보면 된다.
- **상태** = `data-state`·`data-variant`·`data-size` 의 리터럴 값(JSX 속성과 Tailwind
  `data-[k=v]` 셀렉터 양쪽에서 수집) + WAI-ARIA state 속성(`aria-busy` · `aria-checked` · `aria-current` · `aria-disabled` · `aria-expanded` · `aria-invalid` · `aria-pressed` · `aria-selected`).
  aria 프로퍼티(`aria-label`·`aria-controls` 등)와 `aria-hidden`(장식 마스킹)은 상태가
  아니라 제외했다. _(prop 전달)_ 은 값이 리터럴이 아니라 prop 을 그대로 내보내는 경우다.
- **ref** — 모든 컴포넌트는 `React.forwardRef` 래핑이 원칙(D1)이다. §5 의 예외는 위반이
  아니라 ref 를 받을 DOM 노드가 없는 wrapper(Radix `Root`·`Portal`, context provider)다.
- 여기 없는 것: props 전체 목록·타입·기본값(소스의 `XxxProps` 를 읽어라), 클래스 문자열,
  `compoundVariants` 의 조합 내용(개수만 표기).

## 1. 변형 — `cva()` 선언

| 모듈 | cva | 축 | 기본값 | 값 |
|---|---|---|---|---|
| `alert` | `alertVariants` | `intent` | `info` | `info` · `notice` · `warning` · `danger` |
| `button` | `buttonVariants` | `variant` | `default` | `default` · `outline` · `outline-ghost` · `secondary` · `ghost` · `destructive` · `link` · `outline-primary` · `destructive-outline` · `destructive-text` |
| `button` | `buttonVariants` | `size` | `medium` | `exSmall` · `small` · `medium` · `large` · `exLarge` |
| `button-group` | `buttonGroupVariants` | `orientation` | `horizontal` | `horizontal` · `vertical` |
| `chip` | `chipVariants` | `variant` | `solid` | `outline` · `primary` · `solid` |
| `chip` | `chipVariants` | `intent` | `highpositive` | `basic` · `safe` · `danger` · `warning` · `negative` · `positive` · `highpositive` · `stable` |
| `chip` | `chipVariants` | `size` | `small` | `exSmall` · `small` · `medium` |
| `chip` | `chipVariants` | `shape` | `capsule` | `capsule` · `box` |
| `chip` | `chipVariants` | `deletable` | `false` | `true` · `false` |
| `empty` | `emptyMediaVariants` | `variant` | `default` | `default` · `icon` |
| `field` | `fieldVariants` | `orientation` | `vertical` | `vertical` · `horizontal` · `responsive` |
| `input-group` | `inputGroupAddonVariants` | `align` | `inline-start` | `inline-start` · `inline-end` · `block-start` · `block-end` |
| `input-group` | `inputGroupButtonVariants` | `size` | `exSmall` | `exSmall` · `small` · `medium` · `large` · `exLarge` |
| `input.shared` | `fieldControlVariants` | `size` | `medium` | `small` · `medium` · `large` · `exLarge` _(`fieldSizeVariants` 참조)_ |
| `input.shared` | `fieldSurfaceVariants` | `size` | `medium` | `small` · `medium` · `large` · `exLarge` |
| `input.shared` | `fieldTextVariants` | `size` | `medium` | `small` · `medium` · `large` · `exLarge` _(`fieldTextSizeVariants` 참조)_ |
| `item` | `itemVariants` | `variant` | `default` | `default` · `outline` · `muted` |
| `item` | `itemVariants` | `size` | `default` | `default` · `sm` · `xs` |
| `item` | `itemMediaVariants` | `variant` | `default` | `default` · `icon` · `image` |
| `segment` | `segmentItemVariants` | `variant` | — | `box` · `capsule` |
| `segment` | `segmentItemVariants` | `size` | — | `small` · `medium` · `large` |
| `segment` | `segmentIndicatorVariants` | `variant` | — | `box` · `capsule` |
| `sidebar` | `sidebarMenuButtonVariants` | `variant` | `default` | `default` · `outline` |
| `sidebar` | `sidebarMenuButtonVariants` | `size` | `default` | `default` · `sm` · `lg` |
| `tabs` | `tabsListVariants` | `variant` | `default` | `default` · `line` |
| `textarea` | `textareaPrimitiveVariants` | `layout` | `primitive` | `primitive` · `field` |
| `textarea` | `textareaPrimitiveVariants` | `resizeMode` | `auto` | `auto` · `none` · `vertical` |
| `textarea` | `textareaPrimitiveVariants` | `chrome` | `true` | `true` · `false` |
| `toast` | `toastVariants` | `intent` | `default` | `default` · `information` · `success` · `warning` · `error` · `promise` |
| `toggle` | `toggleVariants` | `variant` | `default` | `default` · `outline` |
| `toggle` | `toggleVariants` | `size` | `default` | `default` · `sm` · `lg` |

보충:
- `chip` `chipVariants` — `compoundVariants` 13건(축 조합별 추가 클래스, 값 조합은 소스 확인)
- `navigation-menu` `navigationMenuTriggerStyle` — 변형 축 없음(기본 클래스만)
- `segment` `segmentRootVariants` — 변형 축 없음(기본 클래스만)
- `segment` `segmentItemVariants` — `compoundVariants` 4건(축 조합별 추가 클래스, 값 조합은 소스 확인)

공유 cva 를 import 해 쓰는 모듈(자기 파일에 선언이 없어 위 표에 안 나온다):

- `input` ← `input.shared`
- `input-group` ← `input.shared`
- `native-select` ← `input.shared`
- `select` ← `input.shared`

## 2. 슬롯 — `data-slot`

| 모듈 | 수 | `data-slot` 값 |
|---|---|---|
| `accordion` | 10 | `accordion` · `accordion-item` · `accordion-trigger` · `accordion-trigger-body` · `accordion-trigger-title` · `accordion-trigger-description` · `accordion-trigger-icon-slot` · `accordion-trigger-icon-clip` · `accordion-trigger-icon` · `accordion-content` |
| `alert` | 6 | `alert` · `alert-icon` · `alert-content` · `alert-title` · `alert-description` · `alert-action` |
| `alert-dialog` | 10 | `alert-dialog-trigger` · `alert-dialog-overlay` · `alert-dialog-content` · `alert-dialog-header` · `alert-dialog-footer` · `alert-dialog-media` · `alert-dialog-title` · `alert-dialog-description` · `alert-dialog-action` · `alert-dialog-cancel` |
| `avatar` | 6 | `avatar` · `avatar-image` · `avatar-fallback` · `avatar-badge` · `avatar-group` · `avatar-group-count` |
| `breadcrumb` | 7 | `breadcrumb` · `breadcrumb-list` · `breadcrumb-item` · `breadcrumb-link` · `breadcrumb-page` · `breadcrumb-separator` · `breadcrumb-ellipsis` |
| `button-group` | 2 | `button-group` · `button-group-separator` |
| `card` | 7 | `card` · `card-header` · `card-title` · `card-description` · `card-action` · `card-content` · `card-divider` |
| `carousel` | 5 | `carousel` · `carousel-content` · `carousel-item` · `carousel-previous` · `carousel-next` |
| `checkbox` | 4 | `checkbox` · `checkbox-indicator` · `checkbox-check-icon` · `checkbox-indeterminate` |
| `chip` | 2 | `chip` · `chip-label` |
| `collapsible` | 3 | `collapsible` · `collapsible-trigger` · `collapsible-content` |
| `combobox` | 12 | `combobox` · `combobox-value` · `combobox-trigger` · `combobox-clear` · `combobox-content` · `combobox-list` · `combobox-item` · `combobox-item-indicator` · `combobox-group` · `combobox-label` · `combobox-empty` · `combobox-separator` |
| `command` | 9 | `command` · `command-input-wrapper` · `command-input` · `command-list` · `command-empty` · `command-group` · `command-separator` · `command-item` · `command-shortcut` |
| `context-menu` | 13 | `context-menu-trigger` · `context-menu-group` · `context-menu-sub` · `context-menu-radio-group` · `context-menu-content` · `context-menu-item` · `context-menu-sub-trigger` · `context-menu-sub-content` · `context-menu-checkbox-item` · `context-menu-radio-item` · `context-menu-label` · `context-menu-separator` · `context-menu-shortcut` |
| `copy-button` | 3 | `copy-button` · `copy-button-copied-icon` · `copy-button-icon` |
| `date-time-picker` | 2 | `date-time-picker` · `date-time-picker-time-panel` |
| `dialog` | 9 | `dialog-trigger` · `dialog-close` · `dialog-overlay` · `dialog-content` · `dialog-header` · `dialog-body` · `dialog-footer` · `dialog-title` · `dialog-description` |
| `drawer` | 8 | `drawer-trigger` · `drawer-close` · `drawer-overlay` · `drawer-content` · `drawer-header` · `drawer-footer` · `drawer-title` · `drawer-description` |
| `dropdown-menu` | 15 | `dropdown-menu-trigger` · `dropdown-menu-content` · `dropdown-menu-group` · `dropdown-menu-item` · `dropdown-menu-checkbox-item` · `dropdown-menu-checkbox-item-indicator` · `dropdown-menu-radio-group` · `dropdown-menu-radio-item` · `dropdown-menu-radio-item-indicator` · `dropdown-menu-label` · `dropdown-menu-separator` · `dropdown-menu-shortcut` · `dropdown-menu-sub` · `dropdown-menu-sub-trigger` · `dropdown-menu-sub-content` |
| `empty` | 6 | `empty` · `empty-header` · `empty-icon` · `empty-title` · `empty-description` · `empty-content` |
| `field` | 10 | `field-set` · `field-legend` · `field-group` · `field` · `field-content` · `field-label` · `field-description` · `field-separator` · `field-separator-content` · `field-error` |
| `hover-card` | 2 | `hover-card-trigger` · `hover-card-content` |
| `input-group` | 3 | `input-group` · `input-group-addon` · `input-group-control` |
| `input-otp` | 4 | `input-otp` · `input-otp-group` · `input-otp-slot` · `input-otp-separator` |
| `item` | 10 | `item-group` · `item-separator` · `item` · `item-media` · `item-content` · `item-title` · `item-description` · `item-actions` · `item-header` · `item-footer` |
| `kbd` | 2 | `kbd` · `kbd-group` |
| `menubar` | 15 | `menubar` · `menubar-menu` · `menubar-group` · `menubar-radio-group` · `menubar-trigger` · `menubar-content` · `menubar-item` · `menubar-checkbox-item` · `menubar-radio-item` · `menubar-label` · `menubar-separator` · `menubar-shortcut` · `menubar-sub` · `menubar-sub-trigger` · `menubar-sub-content` |
| `native-select` | 5 | `native-select-wrapper` · `native-select` · `native-select-icon` · `native-select-option` · `native-select-optgroup` |
| `navigation-menu` | 8 | `navigation-menu` · `navigation-menu-list` · `navigation-menu-item` · `navigation-menu-trigger` · `navigation-menu-content` · `navigation-menu-viewport` · `navigation-menu-link` · `navigation-menu-indicator` |
| `navigation-tree` | 3 | `navigation-tree` · `navigation-tree-item` · `navigation-tree-item-label` |
| `pagination` | 5 | `pagination` · `pagination-content` · `pagination-item` · `pagination-link` · `pagination-ellipsis` |
| `popover` | 6 | `popover-trigger` · `popover-anchor` · `popover-content` · `popover-header` · `popover-title` · `popover-description` |
| `progress` | 2 | `progress` · `progress-indicator` |
| `radio` | 2 | `radio` · `radio-indicator` |
| `resizable` | 3 | `resizable-panel-group` · `resizable-panel` · `resizable-handle` |
| `scroll-area` | 4 | `scroll-area` · `scroll-area-viewport` · `scroll-area-scrollbar` · `scroll-area-thumb` |
| `segment` | 6 | `segment` · `segment-item` · `segment-item-indicator` · `segment-item-content` · `segment-item-icon` · `segment-item-label` |
| `select` | 9 | `select-group` · `select-value` · `select-trigger` · `select-scroll-up-button` · `select-scroll-down-button` · `select-content` · `select-label` · `select-item` · `select-separator` |
| `sheet` | 8 | `sheet-trigger` · `sheet-close` · `sheet-overlay` · `sheet-content` · `sheet-header` · `sheet-footer` · `sheet-title` · `sheet-description` |
| `sidebar` | 26 | `sidebar-wrapper` · `sidebar` · `sidebar-gap` · `sidebar-container` · `sidebar-inner` · `sidebar-trigger` · `sidebar-rail` · `sidebar-inset` · `sidebar-input` · `sidebar-header` · `sidebar-footer` · `sidebar-separator` · `sidebar-content` · `sidebar-group` · `sidebar-group-label` · `sidebar-group-action` · `sidebar-group-content` · `sidebar-menu` · `sidebar-menu-item` · `sidebar-menu-button` · `sidebar-menu-action` · `sidebar-menu-badge` · `sidebar-menu-skeleton` · `sidebar-menu-sub` · `sidebar-menu-sub-item` · `sidebar-menu-sub-button` |
| `slider` | 4 | `slider` · `slider-track` · `slider-range` · `slider-thumb` |
| `step-navigation` | 7 | `step-navigation` · `step-navigation-item` · `step-navigation-trigger` · `step-navigation-indicator` · `step-navigation-title` · `step-navigation-description` · `step-navigation-separator` |
| `switch` | 2 | `switch` · `switch-thumb` |
| `table` | 9 | `table-container` · `table` · `table-header` · `table-body` · `table-footer` · `table-row` · `table-head` · `table-cell` · `table-caption` |
| `tabs` | 4 | `tabs` · `tabs-list` · `tabs-trigger` · `tabs-content` |
| `textarea` | 6 | `textarea-count` · `textarea-count-current` · `textarea-count-max` · `textarea-field` · `textarea-field-control` · `textarea` |
| `timeline` | 8 | `timeline` · `timeline-content` · `timeline-date` · `timeline-header` · `timeline-indicator` · `timeline-item` · `timeline-separator` · `timeline-title` |
| `toast` | 4 | `toast` · `toast-icon` · `toast-message` · `toast-action` |
| `toggle-group` | 2 | `toggle-group` · `toggle-group-item` |
| `tooltip` | 4 | `tooltip-provider` · `tooltip-trigger` · `tooltip-content` · `tooltip-arrow` |
| `tree` | 9 | `tree-item` · `tree-item-connector` · `tree-item-row` · `tree-item-toggle` · `tree-item-toggle-spacer` · `tree-item-checkbox-label` · `tree-item-label` · `tree-group` · `tree` |
| `upload` | 15 | `upload` · `upload-header` · `upload-label` · `upload-description` · `upload-count` · `upload-dropzone` · `upload-dropzone-icon` · `upload-empty` · `upload-list` · `upload-file-item` · `upload-file-item-leading` · `upload-file-item-size` · `upload-file-item-action` · `upload-actions` · `upload-errors` |

### 슬롯 1개 (루트만)

`aspect-ratio` · `button` · `calendar` · `checkbox-group` · `date-picker` · `divider` · `input` · `label` · `multiple-date-picker` · `radio-group` · `range-picker` · `range-time-picker` · `skeleton` · `time-picker`(`time-picker-field`) · `toggle`

### 슬롯 없음 (재수출 배럴 · provider · 다른 컴포넌트를 조합만 하는 wrapper)

`ag-grid` · `cds-provider` · `direction` · `icon` · `multi-combobox` · `multi-select` · `search` · `sonner` · `spinner` · `time-panel`

## 3. 상태 — `data-*` · `aria-*`

| 모듈 | `data-state` | `data-variant` | `data-size` | aria 상태 |
|---|---|---|---|---|
| `alert-dialog` | — | — | `exLarge` · `large` · `medium` · `small` · _(prop 전달)_ | — |
| `avatar` | — | — | `default` · `lg` · `sm` · _(prop 전달)_ | — |
| `breadcrumb` | — | — | — | `aria-current` |
| `button` | — | _(prop 전달)_ | _(prop 전달)_ | `aria-expanded` · `aria-invalid` |
| `calendar` | — | — | — | `aria-disabled` · `aria-selected` |
| `checkbox` | `checked` · `indeterminate` · `unchecked` | — | — | `aria-checked` · `aria-invalid` |
| `chip` | — | _(prop 전달)_ | _(prop 전달)_ | — |
| `combobox` | — | — | _(prop 전달)_ | `aria-expanded` |
| `context-menu` | — | `destructive` · _(prop 전달)_ | — | — |
| `date-picker` | — | — | _(prop 전달)_ | — |
| `date-time-picker` | — | — | _(prop 전달)_ | — |
| `dialog` | — | — | `exLarge` · `large` · `medium` · `small` · _(prop 전달)_ | — |
| `dropdown-menu` | `closed` | `destructive` · _(prop 전달)_ | — | — |
| `empty` | — | _(prop 전달)_ | — | — |
| `field` | — | `label` · `legend` · `outline` · _(prop 전달)_ | — | — |
| `input` | — | — | _(prop 전달)_ | — |
| `input-group` | — | — | _(prop 전달)_ | `aria-disabled` · `aria-invalid` |
| `input-otp` | — | — | — | `aria-invalid` |
| `input.shared` | — | — | — | `aria-invalid` |
| `item` | — | _(prop 전달)_ | `sm` · `xs` · _(prop 전달)_ | — |
| `menubar` | — | `destructive` · _(prop 전달)_ | — | `aria-expanded` |
| `multi-combobox` | — | — | _(prop 전달)_ | `aria-disabled` · `aria-expanded` · `aria-invalid` · `aria-selected` |
| `multiple-date-picker` | — | — | _(prop 전달)_ | — |
| `native-select` | — | — | _(prop 전달)_ | `aria-invalid` |
| `navigation-menu` | `hidden` · `visible` | — | — | — |
| `navigation-tree` | — | — | — | `aria-expanded` |
| `pagination` | — | — | — | `aria-current` |
| `radio` | `checked` · `unchecked` | — | — | `aria-invalid` |
| `range-picker` | — | — | _(prop 전달)_ | `aria-expanded` |
| `range-time-picker` | — | — | _(prop 전달)_ | `aria-expanded` |
| `segment` | `on` | _(prop 전달)_ | _(prop 전달)_ | — |
| `select` | `open` | `destructive` | _(prop 전달)_ | `aria-invalid` |
| `sidebar` | `collapsed` · _(prop 전달)_ | `floating` · `inset` · _(prop 전달)_ | `default` · `lg` · `sm` · _(prop 전달)_ | `aria-disabled` · `aria-expanded` |
| `step-navigation` | `default` · `finished` · `now` · _(prop 전달)_ | _(prop 전달)_ | — | — |
| `switch` | `checked` · `unchecked` | — | _(prop 전달)_ | `aria-invalid` |
| `table` | `selected` | — | — | — |
| `tabs` | — | `default` · `line` · _(prop 전달)_ | — | — |
| `textarea` | — | — | — | `aria-invalid` |
| `time-panel` | — | — | — | `aria-disabled` |
| `time-picker` | — | — | _(prop 전달)_ | `aria-expanded` |
| `toggle` | — | — | — | `aria-invalid` · `aria-pressed` |
| `toggle-group` | `on` | `outline` · _(prop 전달)_ | _(prop 전달)_ | — |
| `tooltip` | `delayed-open` | — | — | — |
| `tree` | — | — | — | `aria-expanded` · `aria-selected` |

## 4. compound 서브컴포넌트

| 모듈 | 수 | named export (컴포넌트) |
|---|---|---|
| `accordion` | 4 | `Accordion` · `AccordionContent` · `AccordionItem` · `AccordionTrigger` |
| `ag-grid` | 2 | `AgGrid` · `AllCommunityModule†` |
| `alert` | 4 | `Alert` · `AlertAction` · `AlertDescription` · `AlertTitle` |
| `alert-dialog` | 12 | `AlertDialog` · `AlertDialogAction` · `AlertDialogCancel` · `AlertDialogContent` · `AlertDialogDescription` · `AlertDialogFooter` · `AlertDialogHeader` · `AlertDialogMedia` · `AlertDialogOverlay` · `AlertDialogPortal` · `AlertDialogTitle` · `AlertDialogTrigger` |
| `avatar` | 6 | `Avatar` · `AvatarBadge` · `AvatarFallback` · `AvatarGroup` · `AvatarGroupCount` · `AvatarImage` |
| `breadcrumb` | 7 | `Breadcrumb` · `BreadcrumbEllipsis` · `BreadcrumbItem` · `BreadcrumbLink` · `BreadcrumbList` · `BreadcrumbPage` · `BreadcrumbSeparator` |
| `button-group` | 3 | `ButtonGroup` · `ButtonGroupSeparator` · `ButtonGroupText` |
| `calendar` | 2 | `Calendar` · `CalendarDayButton` |
| `card` | 7 | `Card` · `CardAction` · `CardContent` · `CardDescription` · `CardDivider` · `CardHeader` · `CardTitle` |
| `carousel` | 5 | `Carousel` · `CarouselContent` · `CarouselItem` · `CarouselNext` · `CarouselPrevious` |
| `collapsible` | 3 | `Collapsible` · `CollapsibleContent` · `CollapsibleTrigger` |
| `combobox` | 11 | `Combobox` · `ComboboxContent` · `ComboboxEmpty` · `ComboboxGroup` · `ComboboxInput` · `ComboboxItem` · `ComboboxLabel` · `ComboboxList` · `ComboboxSeparator` · `ComboboxTrigger` · `ComboboxValue` |
| `command` | 9 | `Command` · `CommandDialog` · `CommandEmpty` · `CommandGroup` · `CommandInput` · `CommandItem` · `CommandList` · `CommandSeparator` · `CommandShortcut` |
| `context-menu` | 15 | `ContextMenu` · `ContextMenuCheckboxItem` · `ContextMenuContent` · `ContextMenuGroup` · `ContextMenuItem` · `ContextMenuLabel` · `ContextMenuPortal` · `ContextMenuRadioGroup` · `ContextMenuRadioItem` · `ContextMenuSeparator` · `ContextMenuShortcut` · `ContextMenuSub` · `ContextMenuSubContent` · `ContextMenuSubTrigger` · `ContextMenuTrigger` |
| `dialog` | 11 | `Dialog` · `DialogBody` · `DialogClose` · `DialogContent` · `DialogDescription` · `DialogFooter` · `DialogHeader` · `DialogOverlay` · `DialogPortal` · `DialogTitle` · `DialogTrigger` |
| `drawer` | 10 | `Drawer` · `DrawerClose` · `DrawerContent` · `DrawerDescription` · `DrawerFooter` · `DrawerHeader` · `DrawerOverlay` · `DrawerPortal` · `DrawerTitle` · `DrawerTrigger` |
| `dropdown-menu` | 15 | `DropdownMenu` · `DropdownMenuCheckboxItem` · `DropdownMenuContent` · `DropdownMenuGroup` · `DropdownMenuItem` · `DropdownMenuLabel` · `DropdownMenuPortal` · `DropdownMenuRadioGroup` · `DropdownMenuRadioItem` · `DropdownMenuSeparator` · `DropdownMenuShortcut` · `DropdownMenuSub` · `DropdownMenuSubContent` · `DropdownMenuSubTrigger` · `DropdownMenuTrigger` |
| `empty` | 6 | `Empty` · `EmptyContent` · `EmptyDescription` · `EmptyHeader` · `EmptyMedia` · `EmptyTitle` |
| `field` | 10 | `Field` · `FieldContent` · `FieldDescription` · `FieldError` · `FieldGroup` · `FieldLabel` · `FieldLegend` · `FieldSeparator` · `FieldSet` · `FieldTitle` |
| `hover-card` | 3 | `HoverCard` · `HoverCardContent` · `HoverCardTrigger` |
| `icon` | 2 | `Icon` · `MaterialIconsFont` |
| `input-group` | 5 | `InputGroup` · `InputGroupAddon` · `InputGroupButton` · `InputGroupInput` · `InputGroupText` |
| `input-otp` | 4 | `InputOTP` · `InputOTPGroup` · `InputOTPSeparator` · `InputOTPSlot` |
| `item` | 10 | `Item` · `ItemActions` · `ItemContent` · `ItemDescription` · `ItemFooter` · `ItemGroup` · `ItemHeader` · `ItemMedia` · `ItemSeparator` · `ItemTitle` |
| `kbd` | 2 | `Kbd` · `KbdGroup` |
| `menubar` | 16 | `Menubar` · `MenubarCheckboxItem` · `MenubarContent` · `MenubarGroup` · `MenubarItem` · `MenubarLabel` · `MenubarMenu` · `MenubarPortal` · `MenubarRadioGroup` · `MenubarRadioItem` · `MenubarSeparator` · `MenubarShortcut` · `MenubarSub` · `MenubarSubContent` · `MenubarSubTrigger` · `MenubarTrigger` |
| `multi-combobox` | 7 | `MultiComboboxContent` · `MultiComboboxGroup` · `MultiComboboxItem` · `MultiComboboxSeparator` · `MultiCombobox` · `MultiComboboxTrigger` · `MultiComboboxValue` |
| `multi-select` | 7 | `MultiSelect†` · `MultiSelectContent†` · `MultiSelectGroup†` · `MultiSelectItem†` · `MultiSelectSeparator†` · `MultiSelectTrigger†` · `MultiSelectValue†` |
| `native-select` | 3 | `NativeSelect` · `NativeSelectOptGroup` · `NativeSelectOption` |
| `navigation-menu` | 8 | `NavigationMenu` · `NavigationMenuContent` · `NavigationMenuIndicator` · `NavigationMenuItem` · `NavigationMenuLink` · `NavigationMenuList` · `NavigationMenuTrigger` · `NavigationMenuViewport` |
| `navigation-tree` | 4 | `NavigationTree` · `NavigationTreeDragLine` · `NavigationTreeItem` · `NavigationTreeItemLabel` |
| `pagination` | 7 | `Pagination` · `PaginationContent` · `PaginationEllipsis` · `PaginationItem` · `PaginationLink` · `PaginationNext` · `PaginationPrevious` |
| `popover` | 7 | `Popover` · `PopoverAnchor` · `PopoverContent` · `PopoverDescription` · `PopoverHeader` · `PopoverTitle` · `PopoverTrigger` |
| `radio-group` | 2 | `RadioGroup` · `RadioGroupPrimitive†` |
| `resizable` | 3 | `ResizableHandle` · `ResizablePanel` · `ResizablePanelGroup` |
| `scroll-area` | 2 | `ScrollArea` · `ScrollBar` |
| `segment` | 2 | `Segment` · `SegmentItem` |
| `select` | 10 | `Select` · `SelectContent` · `SelectGroup` · `SelectItem` · `SelectLabel` · `SelectScrollDownButton` · `SelectScrollUpButton` · `SelectSeparator` · `SelectTrigger` · `SelectValue` |
| `sheet` | 8 | `Sheet` · `SheetClose` · `SheetContent` · `SheetDescription` · `SheetFooter` · `SheetHeader` · `SheetTitle` · `SheetTrigger` |
| `sidebar` | 23 | `Sidebar` · `SidebarContent` · `SidebarFooter` · `SidebarGroup` · `SidebarGroupAction` · `SidebarGroupContent` · `SidebarGroupLabel` · `SidebarHeader` · `SidebarInput` · `SidebarInset` · `SidebarMenu` · `SidebarMenuAction` · `SidebarMenuBadge` · `SidebarMenuButton` · `SidebarMenuItem` · `SidebarMenuSkeleton` · `SidebarMenuSub` · `SidebarMenuSubButton` · `SidebarMenuSubItem` · `SidebarProvider` · `SidebarRail` · `SidebarSeparator` · `SidebarTrigger` |
| `step-navigation` | 7 | `StepNavigation` · `StepNavigationDescription` · `StepNavigationIndicator` · `StepNavigationItem` · `StepNavigationSeparator` · `StepNavigationTitle` · `StepNavigationTrigger` |
| `table` | 8 | `Table` · `TableBody` · `TableCaption` · `TableCell` · `TableFooter` · `TableHead` · `TableHeader` · `TableRow` |
| `tabs` | 4 | `Tabs` · `TabsContent` · `TabsList` · `TabsTrigger` |
| `textarea` | 2 | `Textarea` · `TextareaPrimitive` |
| `timeline` | 8 | `Timeline` · `TimelineContent` · `TimelineDate` · `TimelineHeader` · `TimelineIndicator` · `TimelineItem` · `TimelineSeparator` · `TimelineTitle` |
| `toggle-group` | 2 | `ToggleGroup` · `ToggleGroupItem` |
| `tooltip` | 4 | `Tooltip` · `TooltipContent` · `TooltipProvider` · `TooltipTrigger` |
| `upload` | 11 | `Upload` · `UploadActions` · `UploadCount` · `UploadDescription` · `UploadDropzone` · `UploadEmpty` · `UploadErrorList` · `UploadFileItem` · `UploadHeader` · `UploadLabel` · `UploadList` |

† 다른 모듈에서 재수출된 이름 — 정의·슬롯은 원본 모듈에 있다.

### 단일 컴포넌트 모듈

`aspect-ratio` → `AspectRatio` · `button` → `Button` · `cds-provider` → `CDSProvider` · `checkbox` → `Checkbox` · `checkbox-group` → `CheckboxGroup` · `chip` → `Chip` · `copy-button` → `CopyButton` · `date-picker` → `DatePicker` · `date-time-picker` → `DateTimePicker` · `direction` → `DirectionProvider` · `divider` → `Divider` · `input` → `Input` · `label` → `Label` · `multiple-date-picker` → `MultipleDatePicker` · `progress` → `Progress` · `radio` → `Radio` · `range-picker` → `RangePicker` · `range-time-picker` → `RangeTimePicker` · `search` → `Search` · `skeleton` → `Skeleton` · `slider` → `Slider` · `sonner` → `Toaster` · `spinner` → `Spinner` · `switch` → `Switch` · `time-panel` → `TimePanel` · `time-picker` → `TimePicker` · `toast` → `Toast` · `toggle` → `Toggle` · `tree` → `Tree`

## 5. ref 미수용 컴포넌트 (D1 예외)

| 모듈 | ref 미수용 컴포넌트 |
|---|---|
| `alert-dialog` | `AlertDialog` · `AlertDialogPortal` |
| `calendar` | `Calendar` |
| `cds-provider` | `CDSProvider` |
| `combobox` | `Combobox` |
| `command` | `CommandDialog` |
| `context-menu` | `ContextMenu` · `ContextMenuPortal` · `ContextMenuRadioGroup` · `ContextMenuSub` |
| `dialog` | `Dialog` · `DialogPortal` |
| `direction` | `DirectionProvider` |
| `drawer` | `Drawer` · `DrawerPortal` |
| `dropdown-menu` | `DropdownMenu` · `DropdownMenuContent` · `DropdownMenuPortal` · `DropdownMenuSub` |
| `hover-card` | `HoverCard` |
| `icon` | `MaterialIconsFont` |
| `menubar` | `MenubarMenu` · `MenubarPortal` · `MenubarSub` |
| `multi-combobox` | `MultiComboboxContent` · `MultiCombobox` |
| `navigation-tree` | `NavigationTree` · `NavigationTreeItem` |
| `popover` | `Popover` |
| `resizable` | `ResizableHandle` · `ResizablePanel` · `ResizablePanelGroup` |
| `select` | `Select` |
| `sheet` | `Sheet` |
| `sidebar` | `SidebarProvider` |
| `sonner` | `Toaster‡` |
| `step-navigation` | `StepNavigation‡` · `StepNavigationItem‡` |
| `time-picker` | `TimePicker` |
| `timeline` | `Timeline‡` |
| `tooltip` | `Tooltip` · `TooltipProvider` |

‡ `function` 선언이 아니라 화살표 함수(`const X = (props) => ...`)로 정의된 컴포넌트 — 나머지는 `function X(props)` 형태다.

## 6. 헬퍼 모듈 (컴포넌트 없음)

- `icon.constants` — `ICON_VARIANTS` · `ICON_VARIANT_CLASS_NAMES` · `MATERIAL_ICON_NAMES`
- `input.shared` — `fieldControlVariants` · `fieldSizeVariants` · `fieldSurfaceVariants` · `fieldTextVariants` · `isFieldSize`
- `sidebar-state` — `SIDEBAR_COOKIE_NAME` · `getSidebarDefaultOpenFromCookie`
- `time-picker.utils` — `getDefaultTimePickerValue` · `getResolvedMinuteInterval` · `toTimePickerValue` · `getTimePickerColumns` · `formatTimePickerTriggerValue` · `getTimePanelSlots` · `replaceTimePickerValue` · `getTimePickerOptions` · `getPeriodFromHour` · `getHour12`
- `use-date-picker` — `useControlledValue`
- `utils` — `DEFAULT_DATE_FORMAT` · `getDatePickerLocale` · `formatPickerDate` · `getPickerInputSize` · `parseDatePresetValue`
