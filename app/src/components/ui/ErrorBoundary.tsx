"use client";

/**
 * ErrorBoundary — catches React rendering errors in its subtree and shows
 * a branded fallback instead of a white screen. Use around risky panels.
 * Next.js's own app-router error.tsx files cover route-level errors; this
 * is for component-level resilience.
 */

import { Component, type ReactNode } from "react";

interface Props {
  fallback?: (error: Error, reset: () => void) => ReactNode;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[sherwood ErrorBoundary]", error);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      return (
        <div className="sh-empty" role="alert">
          <div className="sh-empty__icon" aria-hidden="true">P.ERR</div>
          <div className="sh-empty__title">Something broke in this panel</div>
          <div className="sh-empty__desc">
            {this.state.error.message || "Unexpected error"}
          </div>
          <button
            type="button"
            className="sh-btn sh-btn--secondary sh-btn--sm"
            style={{ marginTop: "1rem" }}
            onClick={this.reset}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
