import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionIcon, Anchor, Badge, Box, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { post, prospector } from '../api';
import { Dim, LastSurvey, Table, Waiting, bytes, count, howOf } from './Table';
import { linkTo } from '../App';
import type { ReactNode } from 'react';
import type { Asked } from '../api';
import type { Order, Status } from '../types';

/**
 * What every venue is doing, and the buttons that change it.
 *
 * **`state` and `Alive` are shown side by side because they are different
 * facts.** `state` is what the catalog has outstanding; `Alive` is whether this
 * process has a loop doing it. Walking with nothing alive is what a killed
 * container leaves behind, and the one row worth acting on — collapsing the pair
 * into a single status would hide exactly that.
 */
export const Surveys = () => {
  /**
   * **Orders given here and not yet seen to take effect**, by venue.
   *
   * A click is answered in milliseconds and acted on in minutes — a pass lists
   * instruments and writes series before it opens a job — and the row used to
   * read exactly as it had before for the whole of that. Held until the status
   * shows the change, so the row says it heard, and nothing in it can be
   * clicked again until the first order is answered.
   */
  const [orders, setOrders] = useState<Record<string, Order>>({});

  /** Quicker while something is owed an answer, so the answer shows when it lands. */
  const { asked, again } = usePolled<{ items: Status[] }>('/status', prospector,
    Object.keys(orders).length > 0 ? ORDER_POLL_MS : POLL_MS);

  const [busy, setBusy]  = useState<string | null>(null);
  const said             = useFading();

  /** A refresh throws a venue's progress away, so it is confirmed rather than done. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const act = async (
    what:   string,
    body:   unknown,
    label:  string,
    venues: readonly string[],
    kind:   Order['kind'],
  ) => {
    setBusy(label);

    const at = Date.now();

    const stateOf = (venue: string): string | null =>
      asked.data?.items.find(row => row.venue === venue)?.state ?? null;

    setOrders(had => ({
      ...had,
      ...Object.fromEntries(venues.map(venue => [venue, { kind, at, from: stateOf(venue) }])),
    }));

    try {
      const done = await post<{ resumed?: string[]; skipped?: { venue: string }[] }>(
        `/api/prospector${what}`, body);

      // Declined by the catalog — already going, nothing to update from — so
      // there is nothing coming to wait for.
      const declined = (done.skipped ?? []).map(one => one.venue);

      if (declined.length > 0) setOrders(had => without(had, declined));

      /**
       * **A resumed update is said to be one.** The two are indistinguishable
       * from out here and they are not the same thing — one carries on from
       * cursors that already exist, the other plans fresh scopes — so the word
       * the catalog chose is the word that gets shown.
       */
      said.say(done.resumed?.length ? `${label} — resumed where it stopped` : `${label} — asked`);
      again();
    } catch (err) {
      setOrders(had => without(had, venues));
      said.say((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /**
   * **An order leaves when the status shows it done, or when it has plainly
   * not been.** Either way the row is handed back — the first because there is
   * nothing left to wait for, the second because a row held for ever over an
   * order the catalog never acted on is a worse lie than the one this fixes,
   * and it is said out loud rather than dropped.
   */
  useEffect(() => {
    const items = asked.data?.items;

    if (! items || Object.keys(orders).length === 0) return;

    const done:   string[] = [];
    const lapsed: string[] = [];

    for (const [venue, order] of Object.entries(orders)) {
      const now = items.find(one => one.venue === venue);

      if (! now || tookEffect(order, now)) done.push(venue);
      else if (Date.now() - order.at > ORDER_MS) lapsed.push(venue);
    }

    if (done.length + lapsed.length === 0) return;

    setOrders(had => without(had, [...done, ...lapsed]));

    if (lapsed.length > 0)
      said.say(`No sign of ${lapsed.join(', ')} acting on it after ${ORDER_MS / 60_000} minutes — `
        + 'the catalog log will say why');
  }, [asked.data, orders]);

  return (
    <Stack gap="md">
      <Waiting asked={asked}>
        {({ items }) => (
          <Table
            caption="Surveys"
            rows={items}
            columns={[
              {
                /**
                 * **The venue, and under it what it last did.**
                 *
                 * Stacking the two buys the width back for the column that
                 * needed it: what a venue last did is a handful of characters
                 * that never change length, while the schedule beside it is a
                 * sentence and a timestamp and was wrapping every row.
                 *
                 * It also settles the row height without a rule about it. Every
                 * row is two lines because every row has a name and a badge, so
                 * nothing has to impose a minimum to stop one row standing
                 * shorter than its neighbours.
                 *
                 * The name links into the contents view, because the two
                 * questions arrive together: seeing a venue mid-walk is when
                 * somebody wants to know what it has actually got.
                 */
                head: 'Venue',
                width: '15%',
                cell: v => (
                  <Stack gap={4} align="flex-start">
                    <Anchor size="sm" href={linkTo({ venue: v.venue })}>{v.venue}</Anchor>

                    {/*
                      **Resolved here, so the two columns cannot disagree.** The
                      badge takes a run and the state badge takes a venue, and
                      only the second can fall back to `completedEver` where a
                      page is served against a catalog that does not answer
                      `first` yet — so the fallback is applied once, on the way
                      in, rather than in one of the two places.
                    */}
                    <LastSurvey of={{ ...v.lastRun, first: v.lastRun.first ?? ! v.completedEver }} />
                  </Stack>
                ),
              },
              {
                /**
                 * **Wider than it was, out of the column that stopped needing
                 * it.** The badge carries a word and a mark now — `backfilling`
                 * with a walker beside it — and the actions beside the row are
                 * three icons and at most one word, where they used to be three
                 * words.
                 */
                head: 'State', width: '11%', cell: v => <State of={v} order={orders[v.venue]} />,
              },
              {
                /**
                 * **Where the venue is in its passes**, which is the one thing
                 * the state badge beside it cannot say: whether what it holds
                 * was walked end to end or merely topped up, and how long ago.
                 */
                head: 'Runs',
                width: '31%',
                cell: v => <Detail of={v} order={orders[v.venue]} />,
              },
              {
                /**
                 * **Zero and inapplicable are not the same thing.** A venue
                 * whose listing states every file parks nothing ever, and a `0`
                 * there reads as *nothing outstanding* — as though something had
                 * just finished. A dash says the column is not about this venue,
                 * and the figure appears the moment it is: anything parked, or a
                 * pass that works by probing.
                 */
                head:  'WIP',
                width: '10%',
                num:   true,
                cell:  v => (v.wip > 0 || (v.probing ?? v.lastRun.kind === 'update')
                  ? count(v.wip) : <Dim>—</Dim>),
              },
              {
                /**
                 * **The count, and beneath it how many series it is spread
                 * over.** A file total says how much was collected but not how
                 * much of the venue it reaches; the pair below says how many
                 * instruments have been answered for at all, which is what an
                 * update working through them one at a time is getting through.
                 *
                 * Subordinate on purpose — it is context for the figure above,
                 * not a second figure competing with it.
                 */
                head: 'Files',
                width: '12%',
                num:  true,
                cell: v => (
                  <Stack gap={0} align="flex-end">
                    <span>{count(v.files)}</span>

                    {/*
                      Smaller than `Dim` elsewhere, and titled: a figure with no
                      label has to say what it is somehow, and a second column
                      heading would give it the weight this is trying not to have.
                    */}
                    <Text component="span" c="dimmed" fs="italic" size="xs"
                      title={`Series progress — ${count(v.series.withFiles)} of ` +
                        `${count(v.series.total)} series hold at least one file`}>
                      {count(v.series.withFiles)}/{count(v.series.total)}
                    </Text>
                  </Stack>
                ),
              },
              { head: 'Bytes', width: '8%', num: true, cell: v => bytes(v.bytes) },
              {
                head: '',
                width: '13%',
                cell: (v) => {
                  /**
                   * **Nothing in the row is offered while it is mid-change.**
                   *
                   * Two different waits, and both have to count. `busy` is the
                   * request in flight, which is over in milliseconds. `stopping`
                   * is the loop being told to stop and not having noticed yet,
                   * which lasts as long as the page it is on — so the request
                   * finishing is not the venue having settled, and reading only
                   * `busy` handed the row's buttons back while a pause was still
                   * taking effect.
                   *
                   * Acting there is not merely premature: a second interrupt
                   * arriving before the first is answered asks the venue to stop
                   * for something that has already stopped it.
                   */
                  const held    = busy !== null || v.stopping || v.venue in orders
                    || v.state === 'starting';
                  const working = v.state === 'walking' || v.state === 'updating';
                  const waiting = v.state === 'waiting';
                  const paused  = v.state === 'paused';

                  return (
                  <Group gap={6} wrap="nowrap" justify="flex-end">
                    {/*
                      **A word for asking a venue to go, icons for what is done
                      to one already going.** Asking is the decision on this page
                      and reads as a sentence — *Start* a venue nothing has ever
                      finished for, *Update* one something has — while stopping,
                      resuming and refreshing are single familiar shapes.

                      **They keep their places whether or not they apply**, so
                      the column reads as a column and a row does not rearrange
                      itself as a venue changes state. A shape that cannot be
                      clicked here says why in its tooltip.
                    */}
                    <Running of={v} busy={held} act={act} />

                    {/*
                      **One slot for the two opposite things**, because they are
                      opposite: a venue going is stopped here and a stopped one
                      is started again here, and no venue is ever both. Two slots
                      meant one of them greyed out on every row and a reader
                      working out which.

                      Resuming is the same request as starting, so the colour
                      follows the word it replaces: teal for setting a venue
                      going, grey for stopping one.
                    */}
                    <Act
                      colour={paused ? 'teal' : 'gray'}
                      disabled={held || ! (working || waiting || paused)}
                      title={v.stopping ? 'Pausing…'
                        : working || waiting ? 'Pause survey'
                          : paused ? 'Resume survey'
                            : 'Not started yet'}
                      onClick={() => (paused
                        ? act(`/venues/${encodeURIComponent(v.venue)}/surveys`, {}, v.venue, [v.venue], 'go')
                        : act('/surveys/pause', { venue: v.venue }, v.venue, [v.venue], 'pause'))}
                    >{paused ? <Play /> : <Bars />}</Act>

                    {/*
                      **Nothing to re-read, so nothing to offer.** A refresh
                      exists to walk an archive again, and a venue whose bucket
                      refuses a listing has no keyspace to walk: its series are
                      declared and every pass is an update over them. Clicking
                      would drop its run rows and walk nothing.
                    */}
                    <Act
                      colour="orange"
                      disabled={held || ! v.listable}
                      title={v.listable
                        ? 'Start over'
                        : 'Nothing to start over: this venue has no listing'}
                      onClick={() => setConfirming(v.venue)}
                    ><Cycle /></Act>
                  </Group>
                  );
                },
              },
            ]}
          />
        )}
      </Waiting>

      {/*
        **Under the table and to the right, where the per-venue buttons are.**
        These do the same two things to every row at once, so they belong at the
        end of the rows they apply to and in the same column as the buttons they
        repeat — above and to the left they read as the page's controls, which
        invites clicking one before having read what it will apply to.

        **"Start/Resume All" says both words** because the endpoint is one verb
        over a table where some venues have never run and others are paused: the
        button does whichever each venue needs, and naming only one of them would
        be wrong about half the rows.
      */}
      <Group justify="flex-end">
        {said.text && <Text size="sm" c="dimmed">{said.text}</Text>}

        <Button
          size="xs" variant="default" disabled={busy !== null}
          onClick={() => act('/surveys', {}, 'Every venue',
            (asked.data?.items ?? []).filter(v => ! GOING.has(v.state)).map(v => v.venue), 'go')}
        >Start/Resume All</Button>

        <Button
          size="xs" variant="default" disabled={busy !== null}
          onClick={() => act('/surveys/pause', {}, 'Pause',
            (asked.data?.items ?? []).filter(v => v.state !== 'paused' && v.state !== 'not started')
              .map(v => v.venue), 'pause')}
        >Pause All</Button>
      </Group>

      <Modal
        opened={confirming !== null}
        onClose={() => setConfirming(null)}
        title={`Re-survey ${confirming} from scratch?`}
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            This drops its run rows and walks the whole archive again. Everything
            already catalogued stays; the work of having found it does not.
          </Text>

          <Group justify="flex-end">
            <Button size="xs" variant="default" onClick={() => setConfirming(null)}>Cancel</Button>
            <Button
              size="xs" color="orange"
              onClick={() => {
                const venue = confirming!;

                setConfirming(null);
                void act(`/venues/${encodeURIComponent(venue)}/surveys`,
                  { refresh: true }, `${venue} refresh`, [venue], 'go');
              }}
            >Refresh</Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
};

// ── Internals ─────────────────────────────────────────────────────────────────

/** How often the table is read, and how often while an order is owed an answer. */
const POLL_MS       = 10_000;
const ORDER_POLL_MS = 2_000;

/**
 * How long an order is held before it is let go of and said to have lapsed.
 *
 * A pass's preamble is minutes at the longest measured — four, on binance, with
 * new instruments to write — and the catalog reports `starting` from its first
 * second, so an order reaching this unconfirmed is one the catalog never began.
 */
const ORDER_MS = 2 * 60_000;

/** States in which a venue is already going, so asking it to go means nothing. */
const GOING = new Set(['starting', 'walking', 'updating']);

/**
 * Whether the status shows an order done.
 *
 * **A pass that began after the order counts**, not only one still running: a
 * small venue can open and close a whole update between two polls, and waiting
 * for a state it has already left would hold the row until the order lapsed.
 */
const tookEffect = (order: Order, now: Status): boolean => {
  if (order.kind === 'pause') return now.state === 'paused' || now.state === 'not started';

  if (GOING.has(now.state)) return true;

  /**
   * **A pause lifted is done once the venue is no longer paused.** One paused
   * while waiting goes back to waiting — nothing starts, so waiting for a pass
   * would hold the row until the order lapsed and then report it as ignored.
   */
  if (order.from === 'paused' && now.state !== 'paused' && ! now.stopping) return true;

  const began = now.lastRun.startedAt === null ? NaN : Date.parse(now.lastRun.startedAt);

  return began >= order.at - 5_000;
};

const without = (had: Record<string, Order>, venues: readonly string[]): Record<string, Order> =>
  Object.fromEntries(Object.entries(had).filter(([venue]) => ! venues.includes(venue)));

const when = (at: string): string => at.slice(0, 16).replace('T', ' ');

/**
 * How long a pass took, in one unit.
 *
 * **The largest unit the duration fills at least once**, rounded to a whole
 * number of it: a run is compared against other runs of the same venue, where
 * the question is whether it took minutes or hours, and a second figure never
 * changes that answer. `4h` is the whole fact about a walk; `4h 03m` is the same
 * fact costing twice the width.
 */
const took = (from: string, to: string): string => {
  const ms = Date.parse(to) - Date.parse(from);

  const units: [number, string][] = [
    [86400000, 'd'],
    [3600000,  'h'],
    [60000,    'm'],
    [1000,     's'],
  ];

  for (const [size, unit] of units)
    if (ms >= size) return `${Math.round(ms / size)}${unit}`;

  return `${Math.max(ms, 0)}ms`;
};

/**
 * The word that asks a venue to go, where there is something to ask for.
 *
 * **One thing separates the two words, and it is not how the venue is read.**
 * `Start` is a venue no pass has ever finished for; `Update` is one a pass has.
 * Whether that first pass reads a listing or generates keys, and whether the
 * update after it does the same or walks the archive again, is the catalog's
 * business — a word taken from either would call okx and bitget "Update" on
 * their first ever pass, and call gate's next update a walk, which is true and
 * is not what somebody clicking is deciding.
 *
 * **Only where there is something to ask for.** A venue mid-pass is already
 * doing it and a paused one resumes from the play beside this, so both hold the
 * slot open and leave it empty — which is what keeps the icons lined up down the
 * column.
 */
const Running = ({ of, busy, act }: {
  of:   Status;
  busy: boolean;
  act:  (path: string, body: unknown, label: string, venues: readonly string[], kind: Order['kind']) => void;
}) => {
  const waiting = of.state === 'waiting';

  if (of.state !== 'not started' && ! waiting) return <Box w={BUTTON} />;

  /**
   * **A forced update is refused where nothing has ever completed**, so it is
   * sent only by the venue it means something for: one waiting out its interval
   * that is being asked not to wait. Everywhere else the plain request says
   * everything — start it, and it works out what that means.
   */
  return (
    <Button
      size="compact-xs" w={BUTTON}
      variant="light"
      color={waiting ? 'blue' : 'teal'}
      disabled={busy}
      title={waiting
        ? 'Update now'
        : 'Start survey'}
      onClick={() => act(`/venues/${encodeURIComponent(of.venue)}/surveys`,
        waiting ? { update: true } : {},
        waiting ? `${of.venue} update` : of.venue, [of.venue], 'go')}
    >
      {of.completedEver ? 'Update' : 'Start'}
    </Button>
  );
};

/**
 * One of the three things done to a venue that is already going.
 *
 * **A shape and a sentence.** The shape is what the row shows — three of them
 * fit where one word did — and the sentence is in the tooltip, which is where a
 * verb belongs once it has to explain itself: *stops after the current page* is
 * the part of pausing somebody actually wants to know.
 *
 * **Never dropped, only disabled**, so the row keeps its shape as a venue
 * changes state, and the tooltip says why it cannot be clicked.
 */
const Act = ({ colour, title, disabled, onClick, children }: {
  colour:   string;
  title:    string;
  disabled: boolean;
  onClick:  () => void;
  children: ReactNode;
}) => (
  <ActionIcon
    size="sm" variant="light" color={colour}
    title={title} aria-label={title} disabled={disabled} onClick={onClick}
  >
    {children}
  </ActionIcon>
);

/**
 * The three shapes, drawn here rather than installed.
 *
 * Three glyphs at one size do not carry an icon package, and a `currentColor`
 * path inherits the button's colour and its disabled state without any of them
 * having to know what a Mantine variant is.
 *
 * **Hold, go, start over** — a pass being stopped, a paused venue carrying on,
 * an archive being read again from the top.
 */
const Bars = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
    <path d="M4 2.5h2.6v11H4v-11Zm5.4 0H12v11H9.4v-11Z" />
  </svg>
);

const Play = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
    <path d="M3.8 2.4 13 8l-9.2 5.6V2.4Z" />
  </svg>
);

const Cycle = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.9-4.2" />
    <path d="M13.6 1.6v2.8h-2.8" />
  </svg>
);

/**
 * Where the venue stands, in one badge.
 *
 * **Including the one state the catalog cannot report.** A job open with nothing
 * working it is not a survey in progress, and every field that comes back says it
 * is: `state` reads `walking`, the schedule reads `Since …`, the venue's badge
 * reads *in progress*. Only this process knows the difference, because
 * `surveying` is a fact about *it* rather than about the catalog.
 *
 * It used to be a column of its own answering `Yes` / `Stalled` / `—`, where two
 * of the three said nothing that was not already on the row. The exception is the
 * whole of its value, so it belongs where somebody is already looking, and in
 * **red** — it is a fault rather than a phase, and the one row here that wants
 * acting on.
 *
 * Two things leave it: a loop that threw its way out while its run row stayed
 * open, and a venue whose job no deployment in scope will pick up.
 */
const State = ({ of, order }: { of: Status; order?: Order }) => {
  const working = of.state === 'walking' || of.state === 'updating';

  if (working && ! of.surveying)
    return <Badge color="red" variant="light" size="sm">stalled</Badge>;

  /**
   * **Heard, and on its way.** An order this page gave and the catalog has not
   * yet shown — or a pass the catalog says has begun and has not opened its job
   * yet. Both are a venue about to change, and the one thing they must not read
   * as is the state it is leaving.
   */
  const pausing  = order?.kind === 'pause';
  const starting = of.state === 'starting' || order?.kind === 'go';

  if (pausing || starting)
    return (
      <Badge
        color={pausing ? 'orange' : 'teal'} variant="light" size="sm"
        leftSection={<Loader size={9} color="currentColor" />}
        title={pausing ? 'Pausing' : 'Starting'}
      >{pausing ? 'pausing' : 'starting'}</Badge>
    );

  const colour = working ? 'teal'
    : of.state === 'waiting' ? 'blue'
      : of.state === 'paused' ? 'orange' : 'gray';

  /**
   * **What is happening, not how.** `walking` and `updating` are the two
   * mechanisms this service has, and naming the state after one of them made the
   * badge answer a question nobody asked while hiding the one they did: whether
   * this is the first long read of a venue or the daily top-up. So the word is
   * the occasion — **backfilling** the first time, **updating** every time after
   * — and the mechanism stays, as an icon and a tooltip, for whoever wants it.
   */
  /**
   * **`first` where the catalog says so, and the next best thing where it does
   * not.** The page is static files and the API is a process, so a deployment
   * serves a new page against an older catalog for as long as it takes to
   * restart — and a venue that has never completed a pass is backfilling by any
   * reading, which is what makes the fallback safe rather than merely quiet.
   */
  const first = of.lastRun.first ?? ! of.completedEver;
  const said  = ! working ? of.state : first ? 'backfilling' : 'updating';

  return (
    <Badge
      color={colour} variant="light" size="sm"
      title={working && of.lastRun.kind !== null ? howOf(of.lastRun.kind) : undefined}
      leftSection={working && of.lastRun.kind !== null
        ? (of.lastRun.kind === 'walk' ? <Walking /> : <Probing />) : undefined}
    >{said}</Badge>
  );
};

/**
 * The two mechanisms, as shapes.
 *
 * **A walker for reading an index** — it goes through the archive in order,
 * page after page — and **a magnifier for probing**, which asks about one key at
 * a time and mostly hears no. Drawn here for the same reason the survey buttons
 * are: three paths do not carry an icon package, and `currentColor` keeps them
 * inside whatever the badge is coloured.
 */
const Walking = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="9.2" cy="2.6" r="1.4" fill="currentColor" stroke="none" />
    <path d="M9.4 5.2 7 7.6l2 2 .6 4.2" />
    <path d="M7 7.6 4.4 9.2 3.4 13" />
    <path d="M9.4 5.2l2.4 1.6 1.4-.4" />
  </svg>
);

const Probing = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <circle cx="7" cy="7" r="4.2" />
    <path d="M10.2 10.2 14 14" />
  </svg>
);

/**
 * The venue's last meaningful passage of work: a run that is happening, or the
 * newest one that finished.
 *
 * **What a finished pass cost, not when it landed.** How long a venue takes is
 * the figure a cadence is decided on and the one that moves when something
 * changes; the clock time it happened to finish at is the same fact for every
 * venue on the same schedule and answers nothing. The moment is kept, in the
 * tooltip, for the days it matters.
 *
 * **One event, and it is always the same kind of event.** This column used to
 * report whatever the *state* happened to make available — a pause time here, a
 * next-update time there, a job start somewhere else — so no two rows answered
 * the same question and most of them answered none. "was waiting" is the extreme
 * case: it named the phase a pause interrupted, which for a venue between
 * updates is the phase nearly every venue is in nearly all the time.
 *
 * **Paused is deliberately not a case here.** A pause does not close a run or
 * undo one, so it changes nothing about which pass is the newest or when it
 * happened — and the state badge one column to the left already says a person
 * stopped this venue. Two columns saying it left neither saying anything else.
 *
 * Waiting is not a case either: a venue waiting for its next update is one whose
 * update *completed*, which is exactly what it reports.
 */
const Detail = ({ of, order }: { of: Status; order?: Order }) => {
  const run  = of.lastRun;

  /** The occasion, as the badge beside it names it; the mechanism is the title. */
  const what = (run.first ?? ! of.completedEver) ? 'Backfill' : 'Update';

  /**
   * The mechanism, and the moment — both context for the duration, which is the
   * fact the column states.
   */
  const how = run.kind === null
    ? undefined
    : [run.startedAt && `Started at ${when(run.startedAt)}`, howOf(run.kind)]
        .filter(Boolean).join('\n');

  /**
   * **What was asked, not what last happened.** The finished pass below is
   * still true, but it is no longer the news — and shown alone while an order
   * is on its way, it is exactly the row that looked as though nothing was.
   */
  if ((of.state === 'starting' || order?.kind === 'go') && ! run.ongoing)
    return <Text size="sm">{run.kind === null || ! of.completedEver ? 'Backfill' : 'Update'} starting…</Text>;

  if (run.kind === null) return <Dim>Not started yet</Dim>;

  if (run.ongoing)
    return run.startedAt
      ? <Text size="sm" title={how}>{what} started at {when(run.startedAt)}</Text>
      : <Text size="sm" title={how}>{what} in progress</Text>;

  if (run.at === null) return <Dim>—</Dim>;

  return (
    <Stack gap={0} align="flex-start">
      <Text size="sm" title={how}>
        {what} completed {run.startedAt ? `in ${took(run.startedAt, run.at)}` : `at ${when(run.at)}`}
      </Text>

      {/*
        Only where the venue is waiting for the next one. A finished walk sits in
        the same state as a finished update — the first update is simply what is
        scheduled next — so one line covers both.
      */}
      <Due at={of.state === 'waiting' ? of.nextRun : null} />
    </Stack>
  );
};

/**
 * When the next update is due, under the run that finished.
 *
 * **Subordinate on purpose.** What a venue last did is the fact this column
 * exists for; when it will next go is context for that fact, and given equal
 * weight the two compete and the row stops being readable at a glance.
 *
 * **Said only where the venue is actually waiting.** `nextRun` is filled in for
 * a paused venue too — the schedule it *would* be keeping — and a time a paused
 * venue will not honour is worse than no time at all, so the caller passes null
 * for anything but `waiting`.
 *
 * **A due time in the past is said as "now" rather than printed.** The schedule
 * is one loop's intention, not a promise, and a venue whose moment has come and
 * gone is waiting on the loop reaching it — which "due now" describes and a
 * timestamp five minutes stale does not.
 */
const Due = ({ at }: { at: string | null }) => {
  if (at === null) return null;

  return (
    <Text component="span" c="dimmed" fs="italic" size="xs"
      title={`Next update scheduled for ${at}`}>
      {Date.parse(at) <= Date.now() ? 'Next update due now' : `Next update at ${when(at)}`}
    </Text>
  );
};

/**
 * How wide the starting button is.
 *
 * **Fixed, and held even where there is no button**, so every row's icons line
 * up down the column whatever state its venue is in. `Update` is the longest
 * word it shows, and it sets the figure.
 */
const BUTTON = 62;

/** How long an acknowledgement stays on screen before it stops being news. */
const SAID_MS = 6_000;

/**
 * What was just asked for, said once and then forgotten.
 *
 * **It is an acknowledgement, not a status.** "Asked" describes an instant, and
 * left on the page it reads as a condition — which is misleading beside a table
 * that is telling you the actual state every ten seconds.
 */
const useFading = () => {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const say = useCallback((what: string) => {
    setText(what);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(null), SAID_MS);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return { text, say };
};

/**
 * Ask again on a timer, and on demand.
 *
 * **A survey runs for hours and reports nothing when it starts**, so a view of
 * it that only loaded once would show "Idle" for as long as somebody left it
 * open. Ten seconds is often enough to watch a venue change state and rare
 * enough to be free.
 */
const usePolled = <T,>(path: string, ask: (path: string) => Promise<T>, everyMs = POLL_MS) => {
  const [state, setState] = useState<Asked<T>>({ loading: true });

  const again = useCallback(() => {
    ask(path)
      .then(data => setState({ data, loading: false }))

      /**
       * **Keep what was last true.** This runs every ten seconds, so a catalog
       * that is restarting empties the table for as long as it takes to come
       * back — and the figures it replaces were right a moment ago. The error
       * goes beside them instead of over them; the next success clears it.
       */
      .catch((err: Error) => setState(held => ({ ...held, error: err.message, loading: false })));
  }, [path]);

  useEffect(() => {
    again();

    const timer = setInterval(again, everyMs);

    return () => clearInterval(timer);
  }, [again, everyMs]);

  return { asked: state, again };
};
