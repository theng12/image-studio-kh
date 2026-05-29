import { Component } from 'react';
import { Button } from './ui.jsx';

/**
 * Per-page React error boundary. Without this, a render error inside a
 * module silently unmounts the whole tree — leaving the page area blank
 * with no visible reason. This component catches the error, prints it
 * to the console (so devtools sees it), and renders a recoverable
 * "this page crashed" screen with the actual message + stack.
 *
 * Wraps every page in App.jsx so each module gets its own boundary —
 * crashing one page doesn't take the whole app down. The `pageKey` prop
 * is just for diagnostics in the rendered output.
 */
export class PageErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface to the console (devtools) and Electron's stderr — anything
    // that lands here is something we'd want to fix in a follow-up.
    // eslint-disable-next-line no-console
    console.error(`[page:${this.props.pageKey}] render crashed:`, error, info?.componentStack);
    this.setState({ error, info });
  }

  componentDidUpdate(prevProps) {
    // Reset the boundary when the user navigates away — otherwise the
    // error sticks across page changes.
    if (prevProps.pageKey !== this.props.pageKey && this.state.error) {
      this.setState({ error: null, info: null });
    }
  }

  render() {
    if (this.state.error) {
      const { error, info } = this.state;
      return (
        <div className="page__error">
          <h2 className="page__error-title">This page crashed</h2>
          <p className="page__error-sub">
            Page key: <code>{this.props.pageKey}</code>.{' '}
            The rest of the app keeps working — switch to another module from the sidebar.
          </p>
          <pre className="page__error-message">{String(error?.message ?? error)}</pre>
          {info?.componentStack ? (
            <details className="page__error-details">
              <summary>Component stack</summary>
              <pre>{info.componentStack}</pre>
            </details>
          ) : null}
          {error?.stack ? (
            <details className="page__error-details">
              <summary>Full stack</summary>
              <pre>{error.stack}</pre>
            </details>
          ) : null}
          <div style={{ marginTop: 16 }}>
            <Button onClick={() => this.setState({ error: null, info: null })}>Try again</Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
