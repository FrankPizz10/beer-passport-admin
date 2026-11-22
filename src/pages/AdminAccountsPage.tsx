import React from "react";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { AccountsResponse, AdminAccount } from "../api/types";
import { DataTable } from "../components/DataTable";
import { ErrorState, Loading } from "../components/States";
import MaskedValue from "../components/MaskedValue";
import { fmtBool, fmtDate } from "../components/helpers";

const AdminAccountsPage: React.FC = () => {
  const { data, loading, error, reload } = useApiData(
    () => apiGet<AccountsResponse>("/admin/accounts"),
    []
  );
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  return (
    <div>
      <h1>Admin Accounts</h1>
      {data && data.firebase_configured === false && (
        <div className="state-box">
          Firebase is not configured on the server, so accounts cannot be listed.
          This is a configuration state, not an empty account list.
        </div>
      )}
      <DataTable<AdminAccount>
        rows={data?.results ?? []}
        rowKey={(r) => r.uid}
        emptyMessage="No Firebase accounts were returned. The account list is empty for this project."
        columns={[
          { key: "email", label: "Email", render: (r) => r.email || "None" },
          { key: "uid", label: "UID", render: (r) => <MaskedValue value={r.uid} /> },
          { key: "is_admin", label: "Admin", render: (r) => fmtBool(r.is_admin) },
          { key: "created_at", label: "Created", render: (r) => fmtDate(r.created_at) },
          { key: "last_sign_in_at", label: "Last Sign In", render: (r) => fmtDate(r.last_sign_in_at) },
          { key: "disabled", label: "Disabled", render: (r) => fmtBool(r.disabled) },
        ]}
      />
    </div>
  );
};

export default AdminAccountsPage;
