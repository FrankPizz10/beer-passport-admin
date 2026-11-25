import React, { useEffect, useRef, useState } from "react";
import {
  DiscoveryReviewClient,
  ReviewIntent,
  httpDiscoveryReviewClient,
} from "../../api/discoveryReview";
import HelpTip from "../HelpTip";
import {
  ApproveFlowResult,
  ApproveStep,
  ReviewedImageSnapshot,
  runApproveFlow,
} from "./approveFlow";

// Approve-for-import: ONE reviewer action that performs, in order,
// the intent save, the hash-bound image approval, and the
// candidate selection (see approveFlow.ts for the state machine).
// It never publishes or imports anything: a manifest must still be
// built, approved by its exact ID and SHA-256, and imported by the
// operator.
//
// useApproveForImport owns the run state so both the full section
// (button + live checklist) and the guided view's sticky action bar
// (a second trigger for the same run) share one flow. A partial
// failure stops the run with completed steps marked; Resume
// re-checks server state and performs only the missing steps.

export interface ApproveRunner {
  steps: ApproveStep[] | null;
  running: boolean;
  ready: boolean;
  attempted: boolean;
  hasFailure: boolean;
  hasBlock: boolean;
  notReadyReasons: string[];
  conflictStep: ApproveStep | undefined;
  run: () => Promise<void>;
}

export function useApproveForImport(input: {
  candidateId: number;
  client?: DiscoveryReviewClient;
  desiredIntent: ReviewIntent | null;
  // The exact stored preview the reviewer has seen (see
  // approveFlow.ts); the image step approves that fetch or stops.
  reviewedImage?: ReviewedImageSnapshot | null;
  // The saved intent this session started from, so a resume never
  // silently overwrites another reviewer's change.
  baselineIntent?: { id: number; intent: ReviewIntent } | null;
  onCompleted?: () => void;
  onResult?: (result: ApproveFlowResult) => void;
}): ApproveRunner {
  const client = input.client ?? httpDiscoveryReviewClient;
  const [steps, setSteps] = useState<ApproveStep[] | null>(null);
  const [running, setRunning] = useState(false);
  const [ready, setReady] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [notReadyReasons, setNotReadyReasons] = useState<string[]>([]);
  // The last intent THIS flow saved in this session: it becomes the
  // baseline for the next run, so a resume after the reviewer edits
  // their choice is not mistaken for another reviewer's change.
  const flowSavedRef = useRef<{ id: number; intent: ReviewIntent } | null>(
    null
  );
  useEffect(() => {
    flowSavedRef.current = null;
  }, [input.candidateId]);

  const hasFailure = steps?.some((s) => s.status === "failed") ?? false;
  const hasBlock = steps?.some((s) => s.status === "blocked") ?? false;
  const conflictStep = steps?.find((s) => s.conflict);

  const run = async () => {
    if (!input.desiredIntent || running) return;
    setRunning(true);
    setReady(false);
    setAttempted(true);
    try {
      const result = await runApproveFlow({
        client,
        candidateId: input.candidateId,
        desiredIntent: input.desiredIntent,
        reviewedImage: input.reviewedImage ?? null,
        baselineIntent:
          flowSavedRef.current ?? input.baselineIntent,
        onSteps: setSteps,
      });
      setSteps(result.steps);
      setReady(result.ready);
      setNotReadyReasons(result.notReadyReasons);
      if (result.savedIntent) flowSavedRef.current = result.savedIntent;
      if (input.onResult) input.onResult(result);
      if (result.ready && input.onCompleted) input.onCompleted();
    } finally {
      setRunning(false);
    }
  };

  return {
    steps,
    running,
    ready,
    attempted,
    hasFailure,
    hasBlock,
    notReadyReasons,
    conflictStep,
    run,
  };
}

const STEP_ICON: Record<ApproveStep["status"], string> = {
  pending: "○",
  running: "…",
  done: "✓",
  skipped: "–",
  failed: "✗",
  blocked: "!",
};

export const ApproveChecklist: React.FC<{
  runner: ApproveRunner;
}> = ({ runner }) => {
  const {
    steps,
    ready,
    attempted,
    hasFailure,
    hasBlock,
    notReadyReasons,
    conflictStep,
  } = runner;
  if (!steps && !ready) return null;
  return (
    <div className="approve-checklist">
      {steps && (
        <ol className="approve-steps" aria-live="polite">
          {steps.map((step) => (
            <li
              key={step.id}
              className={`approve-step approve-step--${step.status}`}
            >
              <span className="approve-step-icon" aria-hidden="true">
                {STEP_ICON[step.status]}
              </span>
              <span className="approve-step-body">
                <strong>{step.label}</strong> - {step.status}
                {step.detail ? <> · {step.detail}</> : null}
                {step.error ? (
                  <span className="approve-step-error" role="alert">
                    {" "}
                    {step.status === "blocked"
                      ? `Blocked: ${step.error}`
                      : step.status === "failed"
                        ? `Failed: ${step.error}`
                        : step.error}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      )}
      {conflictStep && (
        <div className="queue-preview-failed" role="alert">
          The saved intent changed since this page loaded (revision
          conflict, 409). Reload the page to see the latest intent
          before resuming; no blind overwrite was attempted.
        </div>
      )}
      {attempted && hasFailure && !conflictStep && (
        <p role="note">
          Some steps completed and are marked above; they will not be
          repeated. Fix the problem named on the failed step, then
          use Resume - it re-checks the current state first and runs
          only what is missing.
        </p>
      )}
      {attempted && hasBlock && (
        <p role="note">
          A step above is blocked: it names exactly what must happen
          before this candidate can be approved (for an image block,
          view the current stored preview, or fetch a new image if
          the reviewed one was rejected). Nothing further was
          recorded after the blocked step.
        </p>
      )}
      {attempted && !ready && notReadyReasons.length > 0 && (
        <div className="callout callout-warning" role="status">
          <strong>Not ready for import yet.</strong>
          <ul>
            {notReadyReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
      {ready && (
        <div className="callout callout-info" role="status">
          <strong>Ready for import.</strong> The intent, image
          decision, and selection this candidate needs are recorded.
          Nothing has been published or imported: a manifest must
          still be built from the batch, approved by its exact
          manifest ID and SHA-256, and imported by the operator.
        </div>
      )}
    </div>
  );
};

const ApproveForImport: React.FC<{
  candidateId: number;
  client?: DiscoveryReviewClient;
  // The reviewer's current validated choice, or null when Approve
  // must stay disabled; disabledReason explains why, visibly.
  desiredIntent: ReviewIntent | null;
  disabledReason: string | null;
  reviewedImage?: ReviewedImageSnapshot | null;
  baselineIntent?: { id: number; intent: ReviewIntent } | null;
  onCompleted?: () => void;
}> = ({
  candidateId,
  client,
  desiredIntent,
  disabledReason,
  reviewedImage,
  baselineIntent,
  onCompleted,
}) => {
  const runner = useApproveForImport({
    candidateId,
    client,
    desiredIntent,
    reviewedImage,
    baselineIntent,
    onCompleted,
  });
  return (
    <div className="approve-flow">
      <div className="approve-flow-header">
        <button
          type="button"
          className="btn btn-primary approve-button"
          data-approve-button="true"
          disabled={runner.running || desiredIntent === null}
          onClick={runner.run}
        >
          {runner.running
            ? "Approving..."
            : runner.hasFailure || runner.hasBlock
              ? "Resume - finish the remaining steps"
              : "Approve for import"}
        </button>
        <HelpTip topic="approve for import">
          Approve for import records, in order: your review intent,
          the image approval bound to the exact stored preview you
          viewed (when your choice uses the image), and the candidate
          selection. It does not publish or import anything: a
          manifest still has to be built, approved by its exact hash,
          and imported by the operator.
        </HelpTip>
      </div>
      {desiredIntent === null && disabledReason && (
        <p className="approve-disabled-reason">{disabledReason}</p>
      )}
      <ApproveChecklist runner={runner} />
    </div>
  );
};

export default ApproveForImport;
