import { Component } from 'react';
import { Alert, Button, Stack, Text } from '@mantine/core';
import type { ErrorInfo, ReactNode } from 'react';

/**
 * A part of the page that fails on its own.
 *
 * **A view that throws while rendering takes only itself down.** What it says is
 * shown in its place, with a way to render it again, and everything outside it —
 * the tabs, the other parts — stays usable.
 *
 * `reset` is what the part is showing, such as the route: when it changes the
 * failure is forgotten and the children render again, without remounting them
 * while nothing has failed.
 */
export class ErrorBoundary extends Component<{ reset?: unknown; children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('A view failed to render', error, info.componentStack);
  }

  override componentDidUpdate(before: { reset?: unknown }): void {
    if (this.state.error !== null && ! Object.is(before.reset, this.props.reset)) this.setState({ error: null });
  }

  override render(): ReactNode {
    const { error } = this.state;

    if (error === null) return this.props.children;

    return (
      <Alert color="red" variant="light" title="This part of the page failed" mb="md">
        <Stack gap="xs" align="flex-start">
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{error.message}</Text>
          <Button size="compact-sm" variant="light" color="red" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </Stack>
      </Alert>
    );
  }
}
