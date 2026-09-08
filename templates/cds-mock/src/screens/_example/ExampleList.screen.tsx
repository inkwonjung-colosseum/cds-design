import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@colosseumcoinckr/cds/components/alert";
import { Button } from "@colosseumcoinckr/cds/components/button";
import { Chip } from "@colosseumcoinckr/cds/components/chip";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@colosseumcoinckr/cds/components/empty";
import { Icon } from "@colosseumcoinckr/cds/components/icon";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@colosseumcoinckr/cds/components/pagination";
import { Search } from "@colosseumcoinckr/cds/components/search";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@colosseumcoinckr/cds/components/select";
import { Skeleton } from "@colosseumcoinckr/cds/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@colosseumcoinckr/cds/components/table";
import { rows, statusLabels, totalPages, type ExampleStatus } from "./ExampleList.mock";

export const meta = {
  title: "예시 목록",
  description: "이 파일은 화면 작성 규칙의 참조 예시입니다. 새 화면은 이 형태를 따릅니다.",
  states: ["default", "empty", "loading", "error"],
  frame: "admin",
};

const statusIntent: Record<ExampleStatus, "safe" | "warning" | "basic"> = {
  active: "safe",
  paused: "warning",
  closed: "basic",
};

export default function ExampleListScreen({ state = "default" }: { state?: string }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);

  const visible = rows.filter((row) => {
    const matchesQuery = query === "" || row.name.includes(query) || row.owner.includes(query);
    return matchesQuery && (status === "all" || row.status === status);
  });

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-text-data text-lg font-semibold">예시 목록</h2>
        <Button variant="default" size="medium">
          <Icon name="add" size={20} />
          새로 만들기
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Search
          className="w-72"
          placeholder="이름 또는 담당자"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onReset={() => setQuery("")}
          searchButton
        />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="상태" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">전체 상태</SelectItem>
            <SelectItem value="active">진행중</SelectItem>
            <SelectItem value="paused">보류</SelectItem>
            <SelectItem value="closed">종료</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {state === "error" ? (
        <Alert intent="danger">
          <AlertTitle>목록을 불러오지 못했습니다</AlertTitle>
          <AlertDescription>잠시 후 다시 시도해 주세요.</AlertDescription>
        </Alert>
      ) : state === "loading" ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3, 4].map((row) => (
            <Skeleton key={row} className="h-10 w-full" />
          ))}
        </div>
      ) : state === "empty" || visible.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon name="search_off" size={24} />
            </EmptyMedia>
            <EmptyTitle>조건에 맞는 항목이 없습니다</EmptyTitle>
            <EmptyDescription>검색어나 상태 필터를 바꿔 보세요.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>번호</TableHead>
                <TableHead>이름</TableHead>
                <TableHead>담당자</TableHead>
                <TableHead>상태</TableHead>
                <TableHead>수정일</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono">{row.id}</TableCell>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell>{row.owner}</TableCell>
                  <TableCell>
                    <Chip size="small" variant="solid" intent={statusIntent[row.status]}>
                      {statusLabels[row.status]}
                    </Chip>
                  </TableCell>
                  <TableCell>{row.updatedAt}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious onClick={() => setPage(Math.max(1, page - 1))} />
              </PaginationItem>
              {Array.from({ length: totalPages }, (_, index) => index + 1).map((number) => (
                <PaginationItem key={number}>
                  <PaginationLink isActive={number === page} onClick={() => setPage(number)}>
                    {number}
                  </PaginationLink>
                </PaginationItem>
              ))}
              <PaginationItem>
                <PaginationNext onClick={() => setPage(Math.min(totalPages, page + 1))} />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </>
      )}
    </div>
  );
}
