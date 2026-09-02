import { Alert, Badge, Loader, Table as MTable, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import type { Asked } from '../api';
import type { LastRun } from '../types';

/**
 * The shared pieces every view is built from.
 *
 * **A failure is rendered, not swallowed.** These services answer a refusal with
 * a sentence saying what was wrong with the request, and that sentence is the
 * most useful thing on the page when something is wrong — so it is shown whole
 * rather than replaced by "could not load".
 */

export const Waiting = <T,>({ asked, children }: {
  asked: Asked<T>;
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
    <Alert color="orange" variant="light" title="The catalog refused that" mb="md">
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{asked.error}</Text>
    </Alert>
  );

  if (asked.data !== undefined) return <>{failed}{children(asked.data)}</>;

  if (failed) return failed;

  return <Loader size="sm" type="dots" />;
};

export interface Column<T> {
  head: string;
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
              {col.head}
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
 * A span, said the way the catalog means it.
 *
 * **Where it reaches and whether it is finished are two facts, so both are
 * shown.** `last` is the newest file anybody has seen; `open` is whether the
 * catalog still expects more — the same question it asks before generating a
 * key, so an open shape is one requests are still going out for.
 *
 * They used to be one field, with `last: null` standing for "still publishing".
 * That threw the measurement away to make the claim: every shape reported no end
 * at all, and a variant that stopped beside the one that replaced it — bybit's
 * books at `500,incremental` to 2025-08-20 and `200,incremental` from the 21st —
 * was unreadable, which is exactly what somebody comes to this table for.
 */
export const Span = ({ first, last, open }: {
  first: string | null;
  last:  string | null;
  open:  boolean;
}) =>
  first === null && last === null
    ? <Text component="span" c="dimmed" fs="italic" size="sm">Nothing yet</Text>
    : (
      <>
        {first ?? '?'} … {last ?? '?'}{' '}
        {open
          ? <Badge color="teal" variant="light" size="sm">Open</Badge>
          : <Badge color="orange" variant="light" size="sm">Closed</Badge>}
      </>
    );

/**
 * The venue's most recent pass, named and dated.
 *
 * **A pass in flight is reported as one, not as an absence.** The catalog's
 * completion time is null while a walk is running, so a venue three hours into
 * its first one used to read `Never` — the same word as a venue nobody had ever
 * surveyed, and the opposite of what was happening.
 *
 * **And the kind is shown, because the two are not interchangeable.** A venue
 * whose last pass was a walk has been read end to end; one whose last pass was
 * an update has been asked what appeared since. Somebody deciding whether to
 * trust a span wants to know which of those they are looking at.
 *
 * **Every word stands on its own**, because in the surveys table this sits under
 * the venue name with no column header above it. "Never" needs a heading to mean
 * anything; "Never surveyed" does not.
 */
export const LastSurvey = ({ of }: { of: LastRun }) => {
  const kind = of.kind === 'walk' ? 'Walk' : 'Update';

  const said = of.ongoing ? `${kind} in progress`
    : of.at === null || of.kind === null ? 'Never surveyed'
      : `${of.kind === 'walk' ? 'Walked' : 'Updated'} ${of.at.slice(0, 10)}`;

  return (
    <Badge
      size="xs"

      /**
       * **Quiet, because it is not the answer — it is what the answer rests on.**
       * The state beside it is what somebody reads first, and a pill in full
       * caps at the same weight competed with it. Lower case at a normal weight,
       * on a neutral ground, reads as a caption.
       *
       * Only a pass actually running keeps a colour, because that is the one
       * worth catching an eye.
       */
      tt="none"
      fw={500}
      {...(of.ongoing
        ? { color: 'teal', variant: 'light' as const }
        : { variant: 'default' as const, c: 'dimmed' })}

      /**
       * **Barely rounded, and pulled left by its own padding.**
       *
       * A pill's curve starts before its text does, so under a venue name the
       * text sat indented from the name above it while the badge's edge lined up
       * with it — near-alignment, which reads as a mistake where no alignment at
       * all would not. Squaring the corner removes most of it and the offset
       * removes the rest: the negative margin is exactly the padding Mantine set
       * for this size, so the words line up whatever size it is given.
       */
      radius="sm"
      style={{ marginLeft: 'calc(var(--badge-padding-x) * -1)' }}
    >{said}</Badge>
  );
};

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
