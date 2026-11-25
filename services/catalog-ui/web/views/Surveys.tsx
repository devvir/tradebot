import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionIcon, Anchor, Badge, Box, Button, CloseButton, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { poll, post, prospector } from '../api';
import { Dim, Table, Waiting, bytes, count } from './Table';
import { linkTo } from '../App';
import { GOING, ORDER_MS, ORDER_POLL_MS, POLL_MS, tookEffect, without } from '../surveys/orders';
import { teller } from '../surveys/teller';
import { howOf, took, when } from '../surveys/wording';
import type { ReactNode } from 'react';
import type { Asked } from '../api';
import type { Said } from '../surveys/teller';
import type { FinishedRun, LastRun, Order, Status } from '../types';

/**
 * What every venue is doing, as prospector's `GET /status` reports it, and the
 * buttons that change it.
 *
 * **`state` and `surveying` are different facts, and neither hides the other.**
 * `state` is the work prospector has outstanding for a venue; `surveying` is
 * whether prospector has a loop doing it. Work outstanding with no loop on it is
 * the one row worth acting on, so `State` shows it as `stalled` rather than as
 * the state it claims. What leaves a venue there is set out in
 * docs/services/CATALOG-UI.md.
 */
export const Surveys = () => {
  /**
   * **Orders given here and not yet seen to take effect**, by venue.
   *
   * A click is answered in milliseconds and acted on in minutes — a pass lists
   * instruments and writes series before it opens a job. Held until the status
   * shows the change, so for the whole of that the row says it heard, and
   * nothing in it can be clicked again until the first order is answered.
   */
  const [orders, setOrders] = useState<Record<string, Order>>({});

  /** Quicker while something is owed an answer, so the answer shows when it lands. */
  const { asked, again } = usePolled<{ items: Status[] }>('/status', prospector,
    Object.keys(orders).length > 0 ? ORDER_POLL_MS : POLL_MS);

  const [busy, setBusy]  = useState<string | null>(null);
  const said             = useSaid();

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
    said.clear();

    const at = Date.now();

    const rowOf = (venue: string): Status | undefined =>
      asked.data?.items.find(row => row.venue === venue);

    setOrders(had => ({
      ...had,
      ...Object.fromEntries(venues.map((venue): [string, Order] => [venue, {
        kind,
        at,
        from:          rowOf(venue)?.state ?? null,
        fromStartedAt: rowOf(venue)?.lastRun.startedAt ?? null,
      }])),
    }));

    try {
      const done = await post<{ resumed?: string[]; skipped?: { venue: string }[] }>(
        `/api/prospector${what}`, body);

      // Declined by prospector — already going, nothing to update from — so
      // there is nothing coming to wait for.
      const declined = (done.skipped ?? []).map(one => one.venue);

      if (declined.length > 0) setOrders(had => without(had, declined));

      /**
       * **A resumed update is said to be one.** The two are indistinguishable
       * from out here and they are not the same thing — one carries on from
       * cursors that already exist, the other plans fresh scopes — so the word
       * prospector chose is the word that gets shown.
       */
      said.say(done.resumed?.length ? `${label} — resumed where it stopped` : `${label} — asked`);
      again();
    } catch (err) {
      setOrders(had => without(had, venues));
      said.fail((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /**
   * **An order leaves when the status shows it done, or when it has plainly
   * not been.** Either way the row is handed back — the first because there is
   * nothing left to wait for, the second because a row held for ever over an
   * order prospector never acted on would claim a change that is not coming,
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
      said.fail(`No sign of ${lapsed.join(', ')} acting on it after ${ORDER_MS / 60_000} minutes — `
        + "prospector's log will say why");
  }, [asked.data, orders]);

  return (
    <Stack gap="md">
      <Waiting asked={asked} title="Prospector could not answer">
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
                 * sentence and a timestamp and would wrap every row.
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
                    <LastSurvey of={v.lastRun} />
                  </Stack>
                ),
              },
              {
                /**
                 * **Room for a word and a mark** — `backfilling` with a walker
                 * beside it — taken from the actions column, which holds three
                 * icons and at most one word.
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
                // Sentences, not data: in the page's Sans, where the cells around them are Mono.
                cell: v => <Box ff="text"><Detail of={v} order={orders[v.venue]} /></Box>,
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
                cell:  v => (v.wip > 0 || v.probing ? count(v.wip) : <Dim>—</Dim>),
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
                head: 'Actions',
                hideHead: true,
                width: '13%',
                cell: (v) => {
                  /**
                   * **Nothing in the row is offered while it is mid-change.**
                   *
                   * Two different waits, and both have to count. `busy` is the
                   * request in flight, which is over in milliseconds. `stopping`
                   * is the loop being told to stop and not having noticed yet,
                   * which lasts as long as the page it is on — so the request
                   * finishing is not the venue having settled, and the row stays
                   * held until a pause has taken effect.
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
                      would mean one of them greyed out on every row and a reader
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
                      walks an archive again, and where `/status` reports
                      `listable: false` there is no keyspace to walk: clicking
                      would drop the venue's run rows and walk nothing.
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
        {/*
          **Always in the page, so what lands in it is announced.** A live region
          that appears with its text is one a screen reader has not been
          watching, and says nothing.
        */}
        <div role="status" aria-live="polite">
          {said.now && <Text size="sm" c={said.now.sticks ? 'red' : 'dimmed'}>{said.now.text}</Text>}
        </div>

        {said.now?.sticks && <CloseButton size="sm" aria-label="Dismiss" onClick={said.clear} />}

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

/**
 * The word that asks a venue to go, where there is something to ask for.
 *
 * **One thing separates the two words, and it is not how the venue is read.**
 * `Start` is a venue no pass has ever finished for; `Update` is one a pass has.
 * Whether that first pass reads a listing or generates keys, and whether the
 * update after it does the same or walks the archive again, is prospector's
 * business — a word taken from the mechanism would call a first pass that
 * generates keys "Update", and an update that walks the archive a walk, which is
 * true and is not what somebody clicking is deciding.
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
 * **Including the one state `state` alone does not say.** A job open with
 * nothing working it is not a survey in progress, though `state` reads
 * `walking`, the run reads *started at* and the venue's badge reads *in
 * progress*. `surveying: false` beside it is prospector saying no loop of its own
 * is on the venue, and the pair is shown as **stalled**.
 *
 * It is the exception, so it goes where somebody is already looking rather than
 * in a column of its own, and in **red**: a fault rather than a phase, and the
 * one row here that wants acting on. What leaves a venue stalled is set out in
 * docs/services/CATALOG-UI.md.
 */
const State = ({ of, order }: { of: Status; order?: Order }) => {
  const working = of.state === 'walking' || of.state === 'updating';

  if (working && ! of.surveying)
    return <Badge color="red" variant="light" size="sm">stalled</Badge>;

  /**
   * **Heard, and on its way.** An order this page gave and prospector has not
   * yet shown — or a pass prospector says has begun and has not opened its job
   * yet. Both are a venue about to change, and the one thing they must not read
   * as is the state it is leaving.
   */
  const pausing  = order?.kind === 'pause';
  const starting = of.state === 'starting' || order?.kind === 'go';

  if (pausing || starting)
    return (
      <Badge
        color={pausing ? 'orange' : 'teal'} variant="light" size="sm"
        leftSection={<Loader size={9} color="currentColor" aria-hidden />}
        title={pausing ? 'Pausing' : 'Starting'}
      >{pausing ? 'pausing' : 'starting'}</Badge>
    );

  const colour = working ? 'teal'
    : of.state === 'waiting' ? 'blue'
      : of.state === 'paused' ? 'orange' : 'gray';

  /**
   * **What is happening, not how.** `walking` and `updating` are prospector's
   * two mechanisms, and a badge named after one of them would answer a question
   * nobody asked while hiding the one they did: whether this is the first long
   * read of a venue or the daily top-up. So the word is
   * the occasion — **backfilling** the first time, **updating** every time after
   * — and the mechanism stays, as an icon and a tooltip, for whoever wants it.
   */
  const said = ! working ? of.state : of.lastRun.first ? 'backfilling' : 'updating';

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
 * The venue's most recent pass, named and dated.
 *
 * **A pass in flight is reported as one, not as an absence.** A pass in flight
 * has a null completion time, so the badge says it is in progress rather than
 * `Never surveyed` — which is what a venue with no pass at all reads.
 *
 * **The badge names the occasion; the tooltip names the mechanism.** `Backfill`
 * is the first pass, which reads everything and takes hours or days; `Update` is
 * every pass after it, which reads the recent edge. Whether a pass walked a
 * listing or probed files is a different question, and it is in the tooltip,
 * where somebody who wants it can find it and nobody else has to read it.
 *
 * **Every word stands on its own**, because this sits under the venue name with
 * no column header above it. "Never" needs a heading to mean anything; "Never
 * surveyed" does not.
 */
export const LastSurvey = ({ of }: { of: LastRun }) => {
  const what = of.first ? 'Backfill' : 'Update';

  const said = of.ongoing ? `${what} in progress`
    : of.at === null || of.kind === null ? 'Never surveyed'
      : `${of.first ? 'Backfilled' : 'Updated'} ${of.at.slice(0, 10)}`;

  return (
    <Badge
      size="xs"
      title={of.kind === null ? undefined : howOf(of.kind)}

      /**
       * **Quiet, because it is not the answer — it is what the answer rests on.**
       * The state beside it is what somebody reads first, and a pill in full
       * caps at the same weight would compete with it. Lower case at a normal
       * weight, on a neutral ground, reads as a caption.
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
       * text would sit indented from the name above it while the badge's edge
       * lined up with it — near-alignment, which reads as a mistake where no
       * alignment at all would not. Squaring the corner removes most of it and
       * the offset removes the rest: the negative margin is exactly the padding
       * Mantine sets for this size, so the words line up whatever size it is
       * given.
       */
      radius="sm"
      style={{ marginLeft: 'calc(var(--badge-padding-x) * -1)' }}
    >{said}</Badge>
  );
};

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
 * **One event, and it is always the same kind of event**, whatever the state:
 * the pass that is happening, or the newest one that finished. What a state
 * happens to make available — a pause time, a next-update time, the phase a
 * pause interrupted — would have each row answering a different question.
 *
 * **Paused is deliberately not a case here.** A pause does not close a run or
 * undo one, so it changes nothing about which pass is the newest or when it
 * happened — and the state badge one column to the left already says a person
 * stopped this venue. Two columns saying it would leave neither saying anything
 * else.
 *
 * Waiting is not a case either: a venue waiting for its next update is one whose
 * update *completed*, which is exactly what it reports.
 */
const Detail = ({ of, order }: { of: Status; order?: Order }) => {
  const run  = of.lastRun;

  /** The occasion, as the badge beside it names it; the mechanism is the title. */
  const what = run.first ? 'Backfill' : 'Update';

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
   * still true, but it is not the news — and shown alone while an order is on
   * its way, it would read as though nothing was.
   */
  if ((of.state === 'starting' || order?.kind === 'go') && ! run.ongoing)
    // The pass about to begin, not the last one: `first` describes that, `completedEver` this.
    return <Text size="sm">{run.kind === null || ! of.completedEver ? 'Backfill' : 'Update'} starting…</Text>;

  if (run.kind === null) return <Dim>Not started yet</Dim>;

  if (run.ongoing)
    return (
      <Stack gap={0} align="flex-start">
        {run.startedAt
          ? <Text size="sm" title={how}>{what} started at {when(run.startedAt)}</Text>
          : <Text size="sm" title={how}>{what} in progress</Text>}

        <Before run={run.previous} />
      </Stack>
    );

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
 * What the venue last finished, under the pass that is running — subordinate,
 * like `Due`, because the running pass is the news. Only one backfill ever
 * runs, so it is named as itself; every pass after it is an update.
 */
const Before = ({ run }: { run: FinishedRun | null }) => {
  if (run === null) return null;

  return (
    <Text component="span" c="dimmed" fs="italic" size="xs"
      title={`Started at ${when(run.startedAt)}\nFinished at ${when(run.at)}`}>
      {run.first ? 'Backfill' : 'Last update'} completed in {took(run.startedAt, run.at)}
    </Text>
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

/** `teller`, held by a component for as long as it is mounted. */
const useSaid = () => {
  const [now, setNow] = useState<Said | null>(null);
  const [tell] = useState(() => teller(setNow));

  useEffect(() => () => tell.stop(), [tell]);

  return { now, say: tell.say, fail: tell.fail, clear: tell.clear };
};

/**
 * Ask again on a timer, and on demand.
 *
 * **A survey runs for hours and reports nothing when it starts**, so a view of
 * it that only loaded once would show a state long since left for as long as
 * somebody left it open. Ten seconds is often enough to watch a venue change
 * state and rare enough to be free.
 */
const usePolled = <T,>(path: string, ask: (path: string, signal: AbortSignal) => Promise<T>, everyMs = POLL_MS) => {
  const [state, setState] = useState<Asked<T>>({ loading: true });
  const polling = useRef<{ now: () => void; stop: () => void }>(undefined);

  /** Read at each wait, so a change of pace neither cancels the request in flight nor asks early. */
  const pace = useRef(everyMs);

  pace.current = everyMs;

  useEffect(() => {
    polling.current = poll(signal => ask(path, signal), () => pace.current, {
      data: data => setState({ data, loading: false }),

      /**
       * **Keep what was last true.** This runs every ten seconds, so a service
       * that is restarting would empty the table for as long as it takes to come
       * back — and the figures it replaces were right a moment ago. The error
       * goes beside them instead of over them; the next success clears it.
       */
      error: err => setState(held => ({ ...held, error: err.message, loading: false })),
    });

    return () => polling.current?.stop();
  }, [path]);

  const again = useCallback(() => polling.current?.now(), []);

  return { asked: state, again };
};
