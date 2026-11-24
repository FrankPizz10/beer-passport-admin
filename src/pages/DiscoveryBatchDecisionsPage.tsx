import React from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../api/client";
import { useApiData } from "../api/useApiData";
import { DiscoveryDecision, ListResponse } from "../api/types";
import DataTable, { ColumnDef } from "../components/DataTable";
import { EmptyState, ErrorState, Loading } from "../components/States";
import { fmtDate, fmtVal } from "../components/helpers";

// Batch-level decision audit view: every discovery_decisions row for
// the batch's candidates and pairs, newest first, with the decider
// named (users id + user_name; the API never sends the Firebase UID).
const DiscoveryBatchDecisionsPage: React.FC = () => {
  const { batchId } = useParams();
  const { data, loading, error, reload } = useApiData(
    () =>
      apiGet<ListResponse<DiscoveryDecision>>(
        `/discovery/batches/${batchId}/decisions`,
        { page_size: 100 }
      ),
    [batchId]
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
    { key: "decision", label: "Decision", render: (d) => d.decision },
    {
      key: "candidate_id",
      label: "Candidate",
      render: (d) =>
        d.candidate_id !== null ? (
          <Link to={`/admin/discovery/candidates/${d.candidate_id}`}>
            Candidate {d.candidate_id}
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
    { key: "reason", label: "Reason", render: (d) => fmtVal(d.reason) },
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
        <Link to={`/admin/discovery/batches/${batchId}/candidates`}>
          Back to the batch candidates
        </Link>
      </p>
      {rows.length === 0 ? (
        <EmptyState message="No decisions recorded for this batch yet." />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(d) => d.id} />
      )}
    </div>
  );
};

export default DiscoveryBatchDecisionsPage;
