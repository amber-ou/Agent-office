/**
 * Keeps a render error inside one panel. Without it, any throw while
 * rendering the Agent panel unmounted the whole app — the office went blank
 * white with no message. Shows what failed and how to recover instead.
 */

import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';

interface Props {
  children: ReactNode;
  /** Changing this clears a caught error (e.g. switching tabs). */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[Webview] Agent panel failed to render:', error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="text-warning text-agent-body px-4 py-4" role="alert">
        <p>這個畫面無法顯示：{this.state.error.message}</p>
        <p className="text-text-muted mt-2">
          常見原因是舊版 Agent Office 仍在執行。請關閉所有 Agent Office
          視窗後重新啟動，再開新的網址。
        </p>
      </div>
    );
  }
}
