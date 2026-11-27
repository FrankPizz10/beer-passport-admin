import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { DiscoveryDecision, ListResponse } from "../api/types";
import DataTable, { ColumnDef } from "../components/DataTable";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { fmtDate, fmtVal } from "../components/helpers";
import Pagination from "../components/Pagination";

// Batch-level decision audit view: every discovery_decisions row for
// the batch's candidates and pairs, newest first, with the decider
// named (users id + user_name; the API never sends the Firebase UID).
const DiscoveryBatchDecisionsPage: React.FC = () => {
  const { batchId } = useParams();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const { data, loading, error, reload } = useApiData(
    () =>
      apiGet<ListResponse<DiscoveryDecision>>(
        `/discovery/batches/${batchId}/decisions`,
        { page, page_size: pageSize }
      ),
    [batchId, page, pageSize]
  );
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;

  const rows = data?.results ?? [];

  const columns: ColumnDef<DiscoveryDecision>[] = [
    {
      key: "created_at",
      label: "When",
      render: (d) => fmtDate(d.created_at),
    },
    { key: "decision", label: "Decision", render: (d) => d.decision.replace(/_/g, " ") },
    {
      key: "candidate_id",
      label: "Candidate",
      render: (d) =>
        d.candidate_id !== null ? (
          <Link to={`/admin/discovery/candidates/${d.candidate_id}`}>
            {d.candidate?.name || `Candidate ${d.candidate_id}`}{d.candidate?.brewery_name ? ` · ${d.candidate.brewery_name}` : ""}
          </Link>
        ) : (
          "None"
        ),
    },
    {
      key: "pair_id",
      label: "Pair",
      render: (d) =>
        d.pair_id !== null ? (
          <Link to={`/admin/discovery/pairs/${d.pair_id}`}>Pair {d.pair_id}</Link>
        ) : (
          "None"
        ),
    },
    {
      key: "from_status",
      label: "Change",
      render: (d) => `${fmtVal(d.from_status)} -> ${fmtVal(d.to_status)}`,
    },
    { key: "reason", label: "Reason", render: (d) => d.reason ? d.reason.replace(/_/g, " ") : "None" },
    { key: "note", label: "Note", render: (d) => fmtVal(d.note) },
    {
      key: "decided_by",
      label: "Decided By",
      render: (d) => (d.decided_by ? d.decided_by.user_name : "unknown"),
    },
  ];

  return (
    <div>
      <h1>Batch Decision Audit</h1>
      <p>
        <Link className="btn" to={`/admin/discovery/review-queue?batch=${batchId}`}>
          Open review queue
        </Link>{" "}
        <Link to={`/admin/discovery/batches/${batchId}/candidates`}>
          Back to the batch candidates
        </Link>
      </p>
      {rows.length === 0 ? (
        <EmptyState message="No decisions recorded for this batch yet." />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(d) => d.id} />
      )}
      {data && data.pagination.total_results > 0 && (
        <Pagination page={page} totalPages={data.pagination.total_pages} totalResults={data.pagination.total_results} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} />
      )}
    </div>
  );
};

export default DiscoveryBatchDecisionsPage;
