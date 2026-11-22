import React from "react";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { OverviewCounts } from "../api/types";
import { ErrorState, Loading } from "../components/States";

const CatalogOverviewPage: React.FC = () => {
  const { data, loading, error, reload } = useApiData(
    () => apiGet<OverviewCounts>("/admin/overview"),
    []
  );
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  const entries = data ? Object.entries(data).sort(([a], [b]) => a.localeCompare(b)) : [];
  return (
    <div>
      <h1>Catalog Overview</h1>
      <p>Row counts for all tables in the connected database.</p>
      <div className="counts-grid">
        {entries.map(([table, count]) => (
          <div className="count-card" key={table}>
            <div className="count-name">{table}</div>
            <div className="count-value">{count}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default CatalogOverviewPage;
