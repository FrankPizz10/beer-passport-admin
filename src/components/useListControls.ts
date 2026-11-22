import { useState } from "react";
import { SortDirection } from "./DataTable";

export function useListControls(defaultSort = "id") {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState(defaultSort);
  const [direction, setDirection] = useState<SortDirection>("asc");

  const onSortChange = (nextSort: string, nextDirection: SortDirection) => {
    setSort(nextSort);
    setDirection(nextDirection);
    setPage(1);
  };

  const onPageSizeChange = (size: number) => {
    setPageSize(size);
    setPage(1);
  };

  return {
    page,
    setPage,
    pageSize,
    sort,
    direction,
    onSortChange,
    onPageSizeChange,
    params: { page, page_size: pageSize, sort, direction },
  };
}
