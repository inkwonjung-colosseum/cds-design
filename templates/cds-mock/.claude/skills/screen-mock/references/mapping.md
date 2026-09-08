# 기획서 어휘 → CDS 컴포넌트

import 경로는 항상 `@colosseumcoinckr/cds/components/<파일명>`이다.
export 이름과 props는 소스에서 확인한다: `node_modules/@colosseumcoinckr/cds/src/components/<파일명>.tsx`

## 목록 화면

| 기획서 표현 | 컴포넌트 (파일) | 메모 |
|---|---|---|
| 표, 그리드, 리스트 | `Table` · `TableHeader` · `TableRow` · `TableHead` · `TableBody` · `TableCell` (`table`) | 행 클릭 이동은 `TableRow`에 `onClick` |
| 검색창 | `Search` (`search`) | `searchButton`, `showReset`, `onSearch(value, meta)` |
| 상태·구분 배지 | `Chip` (`chip`) | `intent`: basic·safe·danger·warning·negative·positive·highpositive·stable |
| 드롭다운 필터 | `Select` · `SelectTrigger` · `SelectValue` · `SelectContent` · `SelectItem` (`select`) | 다중 선택은 `MultiSelect`(`multi-select`) |
| 탭 필터 | `Tabs` · `TabsList` · `TabsTrigger` · `TabsContent` (`tabs`) | 세그먼트형은 `Segment` · `SegmentItem`(`segment`) |
| 페이지네이션 | `Pagination` · `PaginationContent` · `PaginationItem` · `PaginationLink` · `PaginationPrevious` · `PaginationNext` (`pagination`) | `PaginationLink`에 `isActive` |
| 빈 상태 | `Empty` · `EmptyHeader` · `EmptyMedia` · `EmptyTitle` · `EmptyDescription` · `EmptyContent` (`empty`) | `EmptyMedia variant="icon"` |
| 로딩 | `Skeleton`(`skeleton`) 또는 `Spinner`(`spinner`) | 목록은 Skeleton, 버튼 안은 Spinner |
| 대량 데이터 그리드 | `AgGrid`(`ag-grid`) | 추가 설치가 필요하므로 **쓰지 않는다**. `Table`로 만들고 HANDOFF에 적는다 |

## 상세 화면

| 기획서 표현 | 컴포넌트 |
|---|---|
| 정보 카드, 요약 박스 | `Card` · `CardHeader` · `CardTitle` · `CardDescription` · `CardAction` · `CardContent` · `CardDivider` (`card`) |
| 라벨-값 나열 | `Field` · `FieldLabel` · `FieldContent` · `FieldDescription` (`field`) |
| 항목 행 | `Item` 계열 (`item`) |
| 이력, 타임라인 | `Timeline` · `TimelineItem` · `TimelineDate` · `TimelineTitle` · `TimelineContent` (`timeline`) |
| 접히는 섹션 | `Accordion`(`accordion`) · `Collapsible`(`collapsible`) |
| 구분선 | `Divider`(`divider`) |
| 아바타, 프로필 사진 | `Avatar`(`avatar`) |

## 폼

| 기획서 표현 | 컴포넌트 |
|---|---|
| 입력 필드 + 라벨 + 오류 문구 | `Field` · `FieldLabel` · `FieldError`(`field`) + `Input`(`input`) |
| 여러 줄 입력 | `Textarea`(`textarea`) |
| 숫자·단위 붙은 입력 | `InputGroup`(`input-group`) |
| 인증번호 | `InputOtp`(`input-otp`) |
| 단일 선택 | `RadioGroup` · `Radio`(`radio-group`, `radio`) · `NativeSelect`(`native-select`) |
| 다중 선택 | `CheckboxGroup` · `Checkbox`(`checkbox-group`, `checkbox`) |
| 검색되는 선택 | `Combobox`(`combobox`) · `MultiCombobox`(`multi-combobox`) |
| 켜기/끄기 | `Switch`(`switch`) · `Toggle`(`toggle`) · `ToggleGroup`(`toggle-group`) |
| 범위 값 | `Slider`(`slider`) |
| 날짜 | `DatePicker`(`date-picker`) · `RangePicker`(`range-picker`) · `DateTimePicker`(`date-time-picker`) · `MultipleDatePicker`(`multiple-date-picker`) |
| 시간 | `TimePicker`(`time-picker`) · `RangeTimePicker`(`range-time-picker`) |
| 파일 첨부 | `Upload`(`upload`) |
| 단계 진행 | `StepNavigation` 계열 (`step-navigation`) |

## 알림·오버레이

| 기획서 표현 | 컴포넌트 | 메모 |
|---|---|---|
| 팝업, 모달 | `Dialog` · `DialogContent` · `DialogHeader` · `DialogTitle` · `DialogBody` · `DialogFooter` (`dialog`) | 화면 파일 1개로 분리하고 `frame: "none"` |
| 삭제·저장 확인 | `AlertDialog` 계열 (`alert-dialog`) | 파괴적 액션 확인에 사용 |
| 우측에서 나오는 패널 | `Sheet`(`sheet`) · `Drawer`(`drawer`) | |
| 안내 배너 | `Alert` · `AlertTitle` · `AlertDescription` · `AlertAction` (`alert`) | `intent`: info·notice·warning·danger |
| 토스트 | `toast`(`toast`) · `Toaster`는 이미 미리보기에 배치됨 | 화면에서 `Toaster`를 다시 렌더하지 않는다 |
| 말풍선 도움말 | `Tooltip` 계열 (`tooltip`) | **`TooltipProvider`로 감싸야 동작한다** |
| 호버 카드 | `HoverCard`(`hover-card`) | |
| 우클릭 메뉴 | `ContextMenu`(`context-menu`) | |
| 더보기 메뉴 | `DropdownMenu`(`dropdown-menu`) | |
| 명령 팔레트 | `Command`(`command`) | |

## 그 외

| 기획서 표현 | 컴포넌트 |
|---|---|
| 버튼 | `Button`(`button`) · 묶음은 `ButtonGroup`(`button-group`) |
| 아이콘 | `Icon name="<Material Symbols 이름>"`(`icon`) — 이름은 타입으로 검사된다 |
| 복사 버튼 | `CopyButton`(`copy-button`) |
| 진행률 | `Progress`(`progress`) |
| 경로 표시 | `Breadcrumb`(`breadcrumb`) |
| 트리 | `Tree`(`tree`) · `NavigationTree`(`navigation-tree`) |
| 이미지 비율 고정 | `AspectRatio`(`aspect-ratio`) |
| 스크롤 영역 | `ScrollArea`(`scroll-area`) |
| 좌우 분할 | `Resizable`(`resizable`) |
| 캐러셀 | `Carousel`(`carousel`) |
| 단축키 표기 | `Kbd`(`kbd`) |

## 화면에서 쓰지 않는 것

- `CDSProvider`, `MaterialIconsFont`, `Toaster` — 미리보기가 이미 감싸고 있다
- `Sidebar` 계열 — 앱 껍데기는 `meta.frame`이 담당한다
- `AgGrid` — 추가 패키지가 필요하다

## 자주 쓰는 토큰 클래스

색은 아래 계열에서만 고른다. 정확한 이름은
`node_modules/@colosseumcoinckr/cds/src/styles/globals.css`와 tokens 패키지에 있고,
`pnpm check`가 존재하지 않는 토큰을 잡아낸다.

| 용도 | 예 |
|---|---|
| 배경 | `bg-background-white` · `bg-background-gray-50` · `bg-background-gray-bg` · `bg-background-primary-cb1` · `bg-background-red-subtle` |
| 글자 | `text-text-data`(본문) · `text-text-description`(보조) · `text-text-primary` · `text-text-red` · `text-text-white` |
| 테두리 | `border-borders-outline` · `border-borders-primary` · `border-borders-red` |
| 아이콘 | `text-icon-natural` · `text-icon-primary` · `text-icon-red` |
