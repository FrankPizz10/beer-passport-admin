import React, { useId } from "react";

interface Props {
  page: number;
  totalPages: number;
  totalResults?: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

export const Pagination: React.FC<Props> = ({
  page,
  totalPages,
  totalResults,
  pageSize,
  onPageChange,
  onPageSizeChange,
}) => {
  const pageSizeId = useId();
  return (
  <div className="pagination">
    <button
      type="button"
      disabled={page <= 1}
      onClick={() => onPageChange(page - 1)}
    >
      Previous
    </button>
    <span>
      Page {page} of {Math.max(totalPages, 1)}
      {typeof totalResults === "number" ? ` (${totalResults} total)` : ""}
    </span>
    <button
      type="button"
      disabled={page >= totalPages}
      onClick={() => onPageChange(page + 1)}
    >
      Next
    </button>
    <label htmlFor={pageSizeId}>
      Page size{" "}
      <select
        id={pageSizeId}
        value={pageSize}
        onChange={(e) => onPageSizeChange(Number(e.target.value))}
      >
        <option value={25}>25</option>
        <option value={50}>50</option>
        <option value={100}>100</option>
      </select>
    </label>
  </div>
  );
};

export default Pagination;
