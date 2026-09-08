# CDS mock 워크스페이스

기획서를 사내 디자인 시스템 CDS로 만든 화면 mock을 모아두는 곳이다.

**대화 상대는 기획자다.** 코드·파일 경로·터미널을 모르는 사람이라고 가정하고, 화면 용어로
말한다. 파일 경로, 명령 출력, 컴포넌트 이름을 답변에 쓰지 않는다.

**모든 문장은 한국어로 쓴다.** 작업 중간에 흘리는 진행 설명("이제 목록 화면을 만듭니다")도
기획자 화면에 그대로 보이므로 한국어여야 한다.

## 작업 절차

기획서가 첨부되거나 화면 요청이 오면 `.claude/skills/screen-mock/SKILL.md`의 절차를 따른다.
CDS 사용법·컴포넌트 카탈로그는 `.claude/skills/cds/SKILL.md`에 있다.

## 불변식

1. **UI는 CDS 컴포넌트로만 만든다.** import는 항상 서브패스다:
   `import { Button } from '@colosseumcoinckr/cds/components/button'`.
   루트 barrel(`from '@colosseumcoinckr/cds'`)은 존재하지 않는다.
   props·variant가 궁금하면 `node_modules/@colosseumcoinckr/cds/src/components/<name>.tsx`
   **소스를 직접 읽는다.** 문서보다 정확하고, 없는 prop을 지어내지 않게 된다.
2. **화면 파일이 import할 수 있는 것**: `react`, `@colosseumcoinckr/*`, 그리고 같은 폴더 안의
   파일. 다른 기능 폴더의 파일을 가져오면 안 된다 — 개발자가 폴더 하나만 복사해 옮긴다.
3. **색은 CDS 토큰 클래스와 컴포넌트 variant로만.** hex·rgb·임의값 클래스(`bg-[#...]`)·
   별도 `.css` 파일 금지. 토큰 이름을 추측하지 말고 실제 존재하는 것을 쓴다
   (`bg-background-white`, `text-text-data`, `text-text-description`, `border-borders-outline`,
   `text-icon-natural` 등. 전체 목록은 cds 스킬의 foundations 참고).
4. **데이터는 `<화면이름>.mock.ts`에만 둔다.** 화면 파일 안에 목록 데이터를 직접 쓰지 않는다.
   개발자가 실제 API로 바꾸는 지점이 한 파일이어야 한다.
5. **화면은 콘텐츠 영역만 만든다.** LNB·헤더·로그인 같은 앱 껍데기는 미리보기가
   `meta.frame`으로 씌운다. 실제 앱에는 이미 껍데기가 있다.
6. **기획서에 없는 것은 지어내지 않고 묻는다.** AskUserQuestion으로 선택지를 제시한다.
   묻기 애매한 사소한 것은 가장 단순한 형태로 만들고 `HANDOFF.md`의 "미결"에 적는다.
7. **CDS에 없는 컴포넌트는 만들지 않는다.** CDS 컴포넌트를 조합해 대체하고
   `HANDOFF.md`에 "CDS 부재"로 적는다.
8. **아래 파일은 수정하지 않는다** — 다음 실행에서 덮어써진다:
   `src/main.tsx`, `src/screens.ts`, `src/ScreenIndex.tsx`, `src/PreviewError.tsx`,
   `src/frames/**`, `src/index.css`, `scripts/**`, `package.json`, `vite.config.ts`,
   `tsconfig.json`, `.claude/**`, `CLAUDE.md`.
   `src/screens/_example/`도 건드리지 않는다 — 규칙 참조용이다.

## 만들고 나서

`pnpm check`를 돌린다. 화면 규칙 검사 + 타입 검사를 한 번에 한다.
**통과하기 전에는 완료라고 답하지 않는다.** 실패 메시지에 무엇을 어떻게 고칠지 적혀 있다.

미리보기 서버는 이미 돌고 있다. 파일을 저장하면 기획자 화면에 바로 반영된다.
`pnpm dev`를 직접 실행하지 않는다.

## 답변 형식

- 만들거나 바꾼 화면을 이름과 미리보기 주소로 적는다: `회원 목록 — #/member/MemberList`
- 판단이 필요한 것은 답변 본문에 쓰지 말고 AskUserQuestion으로 묻는다
- 기획서와 다르게 만든 것이 있으면 무엇을 왜 그렇게 했는지 한 줄로
