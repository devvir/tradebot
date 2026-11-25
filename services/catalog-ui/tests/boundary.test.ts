import { describe, expect, it, vi } from 'vitest';
import { createElement, Fragment } from 'react';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { ErrorBoundary } from '../web/views/ErrorBoundary';

/**
 * `ErrorBoundary`, rendered to markup. A server render never catches, so the
 * failed state is reached the way React reaches it — `getDerivedStateFromError`
 * — and rendered from there.
 */

const markup = (node: ReactNode): string => renderToStaticMarkup(createElement(MantineProvider, null, node));

/** A boundary as React leaves it once `thrown` has escaped one of its children. */
const failedWith = (thrown: unknown, children: ReactNode): ReactNode => {
  const boundary = new ErrorBoundary({ children });

  boundary.state = ErrorBoundary.getDerivedStateFromError(thrown);

  return boundary.render();
};

describe('ErrorBoundary', () => {
  it('renders its children while nothing has failed', () => {
    const html = markup(createElement(ErrorBoundary, null, createElement('p', null, 'Surveys')));

    expect(html).toContain('<p>Surveys</p>');
    expect(html).not.toContain('Try again');
  });

  it('shows what was thrown and a way to try again in place of the part that threw, and nothing of it', () => {
    const html = markup(failedWith(new TypeError("Cannot read properties of undefined (reading 'venues')"),
      createElement('p', null, 'Lenses')));

    expect(html).toContain('This part of the page failed');
    expect(html).toContain('Cannot read properties of undefined (reading &#x27;venues&#x27;)');
    expect(html).toContain('Try again');
    expect(html).not.toContain('Lenses');
  });

  it('leaves the parts beside it as they are', () => {
    const html = markup(createElement(Fragment, null,
      createElement(ErrorBoundary, null, createElement('nav', null, 'Venues / binance')),
      failedWith(new Error('broken'), createElement('p', null, 'Market'))));

    expect(html).toContain('<nav>Venues / binance</nav>');
    expect(html).toContain('broken');
    expect(html).not.toContain('Market');
  });

  it('forgets a failure once what it shows changes, and keeps it while it does not', () => {
    const boundary = new ErrorBoundary({ reset: '#lenses/cold', children: null });
    const cleared: unknown[] = [];

    boundary.setState = (to: unknown) => { cleared.push(to); };
    boundary.state = ErrorBoundary.getDerivedStateFromError(new Error('broken'));

    boundary.componentDidUpdate({ reset: '#lenses/cold' });
    expect(cleared).toEqual([]);

    boundary.componentDidUpdate({ reset: '#lenses/warm' });
    expect(cleared).toEqual([{ error: null }]);
  });

  it('says something for a thrown value that is not an Error', () => {
    expect(ErrorBoundary.getDerivedStateFromError('plain').error.message).toBe('plain');
  });

  it('logs what it caught', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boundary = new ErrorBoundary({ children: null });
    const thrown = new Error('broken');

    boundary.componentDidCatch(thrown, { componentStack: '\n    at Lenses' });

    expect(logged).toHaveBeenCalledWith('A view failed to render', thrown, '\n    at Lenses');
    logged.mockRestore();
  });
});
