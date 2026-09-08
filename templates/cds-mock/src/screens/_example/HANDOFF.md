# _example — 참조 예시

기획서: 없음 (템플릿에 포함된 규칙 예시)

## 화면

| 화면 | 파일 | 미리보기 | 상태 |
|---|---|---|---|
| 예시 목록 | ExampleList.screen.tsx | `#/_example/ExampleList` | default · empty · loading · error |

## 사용한 CDS 컴포넌트

alert, button, chip, empty, icon, pagination, search, select, skeleton, table

## 개발자 이관 메모

이 폴더는 실제 기능이 아니라 **작성 규칙의 참조**입니다. 실제 앱으로 옮기지 마세요.
새 화면을 만들 때 이 파일들의 형태를 그대로 따릅니다:

- `ExampleList.screen.tsx` — `meta` 선언, `state` prop으로 상태 분기, CDS 서브패스 import만
- `ExampleList.mock.ts` — 타입 + 데이터. 실제 화면에서는 이 파일이 API 교체 지점
- 이 문서 — 화면 목록, 사용 컴포넌트, 미결 사항

## 미결

없음
