import React from "react";
import { Link } from "react-router-dom";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  // When this value changes (e.g. the route pathname), a caught error
  // is cleared so navigating away recovers without a full reload.
  resetKey?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

// Recoverable render-error boundary: a page that throws while
// rendering shows this fallback card instead of unmounting the whole
// app to a blank page. Reload clears the error and remounts the
// children; the overview link offers a known-good destination.
export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("ErrorBoundary caught a render error:", error, info);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private handleReload = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className="state-box error-state error-boundary" role="alert">
          <h2>Something went wrong</h2>
          <p>
            This page failed to render
            {this.state.error.message
              ? `: ${this.state.error.message}`
              : "."}
          </p>
          <div className="error-boundary-actions">
            <button type="button" onClick={this.handleReload}>
              Reload
            </button>
            <Link to="/admin/catalog/overview">Back to overview</Link>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
