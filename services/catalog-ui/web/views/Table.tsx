import { Alert, Loader, Table as MTable, Text, VisuallyHidden } from '@mantine/core';
import type { ReactNode } from 'react';
import type { Asked } from '../api';

/**
 * The shared pieces every view is built from.
 *
 * **A failure is rendered, not swallowed.** These services answer a refusal with
 * a sentence saying what was wrong with the request, and that sentence is the
 * most useful thing on the page when something is wrong — so it is shown whole
 * rather than replaced by "could not load".
 */

export const Waiting = <T,>({ asked, title = 'Request failed', children }: {
  asked: Asked<T>;

  /** What the failure notice is headed with: who did not answer, where the view knows. */
  title?: string;

  children: (data: T) => ReactNode;
}) => {
  /**
   * **A failure over data is a notice; a failure instead of data is the page.**
   *
   * A view that polls has usually shown something already, and throwing it away
   * because one refresh failed loses what somebody was reading over a blip they
   * may not care about — a restarted catalog empties the table for as long as it
   * takes to come back. So where there is data the error sits above it and the
   * figures stay, stale but true as of their timestamp.
   *
   * With nothing to show there is nothing to preserve, and the error is all the
   * page has to say.
   */
  const failed = asked.error === undefined ? null : (
    <Alert color="orange" variant="light" title={title} mb="md">
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{asked.error}</Text>
    </Alert>
  );

  if (asked.data !== undefined) return <>{failed}{children(asked.data)}</>;

  if (failed) return failed;

  return <Loader size="sm" type="dots" role="status" aria-label="Loading" />;
};

export interface Column<T> {
  head: string;

  /**
   * Whether the heading is for screen readers only — for a column whose cells
   * say what they are, where a visible word above them would be noise.
   */
  hideHead?: boolean;

  num?: boolean;

  /**
   * How much of the table this column takes — a percentage, or any CSS width.
   *
   * **Given rather than measured, because the rows change.** Left to size
   * itself, a table re-lays out every time a filter narrows it: the columns jump
   * as the longest value in each disappears, and the thing somebody is reading
   * moves under them. A share of the width stays put and still adapts to the
   * window.
   */
  width?: string | number;

  cell: (row: T) => ReactNode;
}

export const Table = <T,>({ caption, columns, rows, empty }: {
  caption: string;
  columns: Column<T>[];
  rows:    readonly T[];
  empty?:  string;
}) => rows.length === 0
  ? <Text c="dimmed" fs="italic" size="sm">{empty ?? `${caption}: nothing`}</Text>
  : (
    <MTable
      striped="even"
      highlightOnHover
      withTableBorder
      horizontalSpacing="md"
      verticalSpacing={6}
      captionSide="top"
      fz="sm"
      layout={columns.some(col => col.width !== undefined) ? 'fixed' : 'auto'}
    >
      <MTable.Caption ta="left" fz="xs" c="dimmed" mb="xs">{caption}</MTable.Caption>
      <MTable.Thead>
        <MTable.Tr>
          {columns.map(col => (
            <MTable.Th key={col.head} ta={col.num ? 'right' : 'left'} w={col.width}>
              {col.hideHead ? <VisuallyHidden>{col.head}</VisuallyHidden> : col.head}
            </MTable.Th>
          ))}
        </MTable.Tr>
      </MTable.Thead>
      <MTable.Tbody>
        {rows.map((row, at) => (
          <MTable.Tr key={at}>
            {columns.map(col => (
              <MTable.Td
                key={col.head}
                ta={col.num ? 'right' : 'left'}
                style={{
                  ...(col.num ? { fontVariantNumeric: 'tabular-nums' } : {}),

                  /**
                   * **Centred within whatever height the row takes**, so a
                   * one-line cell sits level with a taller one beside it rather
                   * than hanging from the top of it.
                   */
                  verticalAlign: 'middle',

                  /** A long value wraps rather than widening a fixed column. */
                  overflowWrap: 'anywhere',
                }}
              >
                {col.cell(row)}
              </MTable.Td>
            ))}
          </MTable.Tr>
        ))}
      </MTable.Tbody>
    </MTable>
  );

/**
 * A span, from the oldest period to the newest file anybody has seen.
 *
 * **Both ends are measurements**, so a variant that stopped beside the one that
 * replaced it reads as two adjacent spans — one ending on the day before the
 * other begins — which is exactly what somebody comes to this table for.
 */
export const Span = ({ first, last }: { first: string | null; last: string | null }) =>
  first === null && last === null
    ? <Text component="span" c="dimmed" fs="italic" size="sm">Nothing yet</Text>
    : <>{first ?? '?'} … {last ?? '?'}</>;

export const Dim = ({ children }: { children: ReactNode }) =>
  <Text component="span" c="dimmed" fs="italic" size="sm">{children}</Text>;

export const bytes = (n: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

  let at = 0;
  let size = n;

  while (size >= 1024 && at < units.length - 1) { size /= 1024; at++; }

  return `${size < 10 && at > 0 ? size.toFixed(1) : Math.round(size)} ${units[at]}`;
};

export const count = (n: number): string => n.toLocaleString();
