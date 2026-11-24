import React from "react";

// Status chip with a text label (never color-only). The variant is
// chosen from the status vocabulary the API already returns; unknown
// statuses render as neutral chips with the raw label.
const VARIANT_BY_STATUS: Record<string, string> = {
  pending: "pending",
  selected: "selected",
  held: "held",
  rejected: "rejected",
  superseded: "neutral",
  draft: "draft",
  approved: "approved",
  imported: "imported",
  void: "void",
  staged: "neutral",
  active: "selected",
};

export const statusChipVariant = (status: string): string =>
  VARIANT_BY_STATUS[status] ?? "neutral";

const StatusChip: React.FC<{
  status: string;
  label?: string;
}> = ({ status, label }) => (
  <span className={`status-chip status-chip--${statusChipVariant(status)}`}>
    {label ?? status}
  </span>
);

export default StatusChip;
