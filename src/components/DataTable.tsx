import React from "react";
import { EmptyState, Loading } from "./States";

export interface ColumnDef<T> {
  key: string;
  label: string;
  sortable?: boolean;
  render?: (row: T) => React.ReactNode;
}

export type SortDirection = "asc" | "desc";

interface Props<T> {
  columns: ColumnDef<T>[];
  rows: T[];
  sort?: string;
  direction?: SortDirection;
  onSortChange?: (sort: string, direction: SortDirection) => void;
  loading?: boolean;
  emptyMessage?: string;
  rowKey?: (row: T) => string | number;
}

export function DataTable<T extends object>({
  columns,
  rows,
  sort,
  direction,
  onSortChange,
  loading,
  emptyMessage = "No records found. This table is empty in this database.",
  rowKey,
}: Props<T>) {
  if (loading) return <Loading />;
  if (!rows || rows.length === 0) return <EmptyState message={emptyMessage} />;

  const handleSort = (col: ColumnDef<T>) => {
    if (!col.sortable || !onSortChange) return;
    if (sort === col.key) {
      onSortChange(col.key, direction === "asc" ? "desc" : "asc");
    } else {
      onSortChange(col.key, "asc");
    }
  };

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key}>
                {col.sortable && onSortChange ? (
                  <button
                    type="button"
                    className="sort-button"
                    onClick={() => handleSort(col)}
                  >
                    {col.label}
                    {sort === col.key ? (direction === "asc" ? " ^" : " v") : ""}
                  </button>
                ) : (
                  col.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={rowKey ? rowKey(row) : (row as any).id ?? idx}>
              {columns.map((col) => (
                <td key={col.key} data-label={col.label}>
                  {col.render
                    ? col.render(row)
                    : String((row as any)[col.key] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default DataTable;
