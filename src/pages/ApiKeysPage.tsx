import React from "react";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { ApiKey, ListResponse } from "../api/types";
import { DataTable } from "../components/DataTable";
import Pagination from "../components/Pagination";
import { ErrorState } from "../components/States";
import { fmtBool, fmtDate } from "../components/helpers";
import { useListControls } from "../components/useListControls";

const ApiKeysPage: React.FC = () => {
  const controls = useListControls("id");
  const { data, loading, error, reload } = useApiData(
    () => apiGet<ListResponse<ApiKey>>("/admin/api-keys", controls.params),
    [JSON.stringify(controls.params)]
  );
  if (error && !loading) return <ErrorState message={error.message} onRetry={reload} />;
  return (
    <div>
      <h1>API Keys</h1>
      <p className="note">Key values are never displayed. This page shows metadata only.</p>
      <DataTable<ApiKey>
        loading={loading} rows={data?.results ?? []} sort={controls.sort} direction={controls.direction} onSortChange={controls.onSortChange}
        emptyMessage="No API keys found. The api_keys table is empty in this database."
        columns={[
          { key: "id", label: "ID", sortable: true },
          { key: "name", label: "Name" },
          { key: "revoked", label: "Revoked", render: (r) => fmtBool(r.revoked) },
          { key: "created_at", label: "Created", sortable: true, render: (r) => fmtDate(r.created_at) },
          { key: "last_used_at", label: "Last Used", render: (r) => fmtDate(r.last_used_at) },
          { key: "last_mod", label: "Last Modified", render: (r) => fmtDate(r.last_mod) },
        ]}
      />
      {data && <Pagination page={data.pagination.page} totalPages={data.pagination.total_pages} totalResults={data.pagination.total_results} pageSize={controls.pageSize} onPageChange={controls.setPage} onPageSizeChange={controls.onPageSizeChange} />}
    </div>
  );
};

export default ApiKeysPage;
