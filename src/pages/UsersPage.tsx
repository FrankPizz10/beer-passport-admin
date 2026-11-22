import React, { useState } from "react";
import { Link } from "react-router-dom";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { AppUser, ListResponse } from "../api/types";
import { DataTable } from "../components/DataTable";
import Pagination from "../components/Pagination";
import { ErrorState } from "../components/States";
import { fmtBool, fmtDate, fmtVal } from "../components/helpers";
import { useListControls } from "../components/useListControls";

const UsersPage: React.FC = () => {
  const controls = useListControls("created_at");
  const [q, setQ] = useState("");
  const [priv, setPriv] = useState("");
  const params = { ...controls.params, q: q || undefined, private: priv === "" ? undefined : priv };
  const { data, loading, error, reload } = useApiData(
    () => apiGet<ListResponse<AppUser>>("/users", params),
    [JSON.stringify(params)]
  );
  if (error && !loading) return <ErrorState message={error.message} onRetry={reload} />;
  return (
    <div>
      <h1>Users</h1>
      <div className="filters">
        <input aria-label="Search users" placeholder="Search users" value={q} onChange={(e) => { setQ(e.target.value); controls.setPage(1); }} />
        <select aria-label="Private" value={priv} onChange={(e) => { setPriv(e.target.value); controls.setPage(1); }}>
          <option value="">Any visibility</option>
          <option value="true">Private</option>
          <option value="false">Public</option>
        </select>
      </div>
      <DataTable<AppUser>
        loading={loading} rows={data?.results ?? []} sort={controls.sort} direction={controls.direction} onSortChange={controls.onSortChange}
        emptyMessage="No users found. The users table is empty in this database, or no rows match the filters."
        columns={[
          { key: "id", label: "ID", sortable: true },
          { key: "user_name", label: "User Name", render: (r) => <Link to={`/admin/users/${r.id}`}>{r.user_name}</Link> },
          { key: "email", label: "Email" },
          { key: "age", label: "Age", render: (r) => fmtVal(r.age) },
          { key: "private", label: "Private", render: (r) => fmtBool(r.private) },
          { key: "created_at", label: "Created", sortable: true, render: (r) => fmtDate(r.created_at) },
          { key: "beer_count", label: "Beers Tried" },
          { key: "badge_count", label: "Badges" },
        ]}
      />
      {data && <Pagination page={data.pagination.page} totalPages={data.pagination.total_pages} totalResults={data.pagination.total_results} pageSize={controls.pageSize} onPageChange={controls.setPage} onPageSizeChange={controls.onPageSizeChange} />}
    </div>
  );
};

export default UsersPage;
