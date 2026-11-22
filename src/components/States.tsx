import React from "react";

export const Loading: React.FC = () => (
  <div className="state-box" role="status">
    Loading...
  </div>
);

export const EmptyState: React.FC<{ message: string }> = ({ message }) => (
  <div className="state-box empty-state">{message}</div>
);

export const ErrorState: React.FC<{
  message: string;
  onRetry?: () => void;
}> = ({ message, onRetry }) => (
  <div className="state-box error-state" role="alert">
    <p>{message}</p>
    {onRetry && (
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    )}
  </div>
);
