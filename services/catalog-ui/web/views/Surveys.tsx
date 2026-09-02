import { useCallback, useEffect, useRef, useState } from 'react';
import { Anchor, Badge, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { catalog, post } from '../api';
import { Dim, LastSurvey, Table, Waiting, bytes, count } from './Table';
import { linkTo } from '../App';
import type { Asked } from '../api';
import type { Status } from '../types';

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
  const { asked, again } = usePolled<{ items: Status[] }>('/status', catalog);
  const [busy, setBusy]  = useState<string | null>(null);
  const said             = useFading();

  /** A refresh throws a venue's progress away, so it is confirmed rather than done. */
  const [confirming, setConfirming] = useState<string | null>(null);

  const act = async (what: string, body: unknown, label: string) => {
    setBusy(label);

    try {
      const done = await post<{ resumed?: string[] }>(`/api/catalog${what}`, body);

      /**
       * **A resumed update is said to be one.** The two are indistinguishable
       * from out here and they are not the same thing — one carries on from
       * cursors that already exist, the other plans fresh scopes — so the word
       * the catalog chose is the word that gets shown.
       */
      said.say(done.resumed?.length ? `${label} — resumed where it stopped` : `${label} — asked`);
      again();
    } catch (err) {
      said.say((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

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
                    <LastSurvey of={v.lastRun} />
                  </Stack>
                ),
              },
              { head: 'State', width: '9%', cell: v => <State of={v} /> },
              {
                /**
                 * **Where the venue is in its passes**, which is the one thing
                 * the state badge beside it cannot say: whether what it holds
                 * was walked end to end or merely topped up, and how long ago.
                 */
                head: 'Runs',
                width: '32%',
                cell: v => <Detail of={v} />,
              },
              { head: 'WIP', width: '10%', num: true, cell: v => count(v.wip) },
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
                width: '11%',
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
                width: '15%',
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
                  const held = busy !== null || v.stopping;

                  return (
                  <Group gap="xs" wrap="nowrap" justify="flex-end">
                    {/*
                      **One button, because there is only ever one thing to do
                      to a venue.** A venue is running or it is not: the verb is
                      start it, stop it, or ask the one that is idle to go now.
                      Those are never available together, so three buttons meant
                      two disabled ones in every row and a reader working out
                      which of them was live.

                      The word is the whole of it. Starting and resuming are one
                      request — a pause keeps every cursor — and a venue with no
                      keyspace to walk has no *Start* to offer at all, so the
                      label says what clicking will mean *here* rather than
                      naming an endpoint.

                      **A fixed width and a colour per action**, because the
                      button occupies the same place in every row: left to size
                      themselves the words differ by a few pixels and the column
                      wanders down the table. Teal sets a venue going, blue asks
                      for a pass it would otherwise wait for, grey stops it, and
                      orange stays reserved for the one that throws work away.
                    */}
                    <Running of={v} busy={held} act={act} />

                    {/*
                      **Nothing to re-read, so nothing to offer.** A refresh
                      exists to walk an archive again, and a venue whose bucket
                      refuses a listing has no keyspace to walk: its series are
                      declared and every pass is an update over them. Clicking
                      would drop its run rows and walk nothing.

                      Disabled rather than dropped, so both buttons keep their
                      places in every row and the column reads as a column.
                    */}
                    <Button
                      size="compact-xs" variant="light" color="orange" w={BUTTON}
                      disabled={held || ! v.listable}
                      title={v.listable ? undefined
                        : 'Nothing to re-walk — this venue publishes no listing'}
                      onClick={() => setConfirming(v.venue)}
                    >Refresh</Button>
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
          onClick={() => act('/surveys', {}, 'Every venue')}
        >Start/Resume All</Button>

        <Button
          size="xs" variant="default" disabled={busy !== null}
          onClick={() => act('/surveys/pause', {}, 'Pause')}
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
                  { refresh: true }, `${venue} refresh`);
              }}
            >Refresh</Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
};

// ── Internals ─────────────────────────────────────────────────────────────────

const when = (at: string): string => at.slice(0, 16).replace('T', ' ');

/**
 * The one button that decides whether a venue is meant to be running.
 *
 * **Three words, two endpoints, one question.** Pausing and starting are
 * genuinely opposite, so they cannot be the same request — but *starting* and
 * *resuming* are the same request, because a pause keeps every cursor and the
 * service has no separate resume verb to offer. So the word changes and the call
 * does not, which is the honest way round: it tells somebody what clicking will
 * mean here without inventing a distinction the catalog does not make.
 *
 * A venue whose pause has been asked for and not yet taken shows `Pausing…` and
 * is disabled, because the answer to clicking again is "already asked".
 */
const Running = ({ of, busy, act }: {
  of:   Status;
  busy: boolean;
  act:  (path: string, body: unknown, label: string) => void;
}) => {
  const working = of.state === 'walking' || of.state === 'updating';
  const paused  = of.state === 'paused';

  /**
   * **What clicking does here, which the venue's phase alone does not settle.**
   *
   * A venue with no keyspace to walk has no *Start* to offer: its series are
   * declared rather than discovered, so the first thing it can do is the same
   * thing every later pass does. Saying `Start` there would promise a walk that
   * cannot happen.
   */
  const label = of.stopping ? 'Pausing…'
    : working ? 'Pause'
      : paused ? 'Resume'
        : of.state === 'not started' && of.listable ? 'Start' : 'Update';

  /**
   * **A forced update is refused where nothing has completed**, so a venue
   * running for the first time sends the plain request whatever the word on the
   * button says — `update: true` would come back "walk it first", and for an
   * unlisted venue there is no walk to do. `update: true` is therefore only for
   * the one case it means something: a venue **waiting** out its interval that
   * is being asked not to wait.
   */
  const forcing = of.state === 'waiting';

  return (
    <Button
      size="compact-xs" w={BUTTON}

      /**
       * **Resuming is routine; starting is not.** They are the same request and
       * the same colour, so at the same weight a table of paused venues reads as
       * a row of things demanding to be clicked — and a venue nobody has ever
       * asked for is the one that wants noticing.
       *
       * **An outline rather than nothing.** Resume is the button most often
       * wanted on this page, so dropping it to no background at all buried the
       * common action to make room for the rare one. It keeps its edge and its
       * colour and gives up only the fill: still plainly a button, still teal,
       * one step behind the venue that has never run.
       */
      variant={paused ? 'outline' : 'light'}
      color={working || of.stopping ? 'gray' : label === 'Update' ? 'blue' : 'teal'}
      disabled={busy || of.stopping}
      onClick={() => (working
        ? act('/surveys/pause', { venue: of.venue }, of.venue)
        : act(`/venues/${encodeURIComponent(of.venue)}/surveys`,
          forcing ? { update: true } : {},
          forcing ? `${of.venue} update` : of.venue))}
    >
      {label}
    </Button>
  );
};

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
const State = ({ of }: { of: Status }) => {
  const working = of.state === 'walking' || of.state === 'updating';

  if (working && ! of.surveying)
    return <Badge color="red" variant="light" size="sm">stalled</Badge>;

  const colour = working ? 'teal'
    : of.state === 'waiting' ? 'blue'
      : of.state === 'paused' ? 'orange' : 'gray';

  return <Badge color={colour} variant="light" size="sm">{of.state}</Badge>;
};

/**
 * The venue's last meaningful passage of work: a run that is happening, or the
 * newest one that finished.
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
const Detail = ({ of }: { of: Status }) => {
  const run  = of.lastRun;
  const kind = run.kind === 'walk' ? 'Walk' : 'Update';

  if (run.kind === null) return <Dim>Not started yet</Dim>;

  if (run.ongoing)
    return run.startedAt
      ? <Text size="sm">{kind} started at {when(run.startedAt)}</Text>
      : <Text size="sm">{kind} in progress</Text>;

  if (run.at === null) return <Dim>—</Dim>;

  return (
    <Stack gap={0} align="flex-start">
      <Text size="sm">{kind} completed at {when(run.at)}</Text>

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
 * How wide every per-venue button is.
 *
 * **The same for all of them**, so the column reads as a column. `Pausing…` is
 * the longest word any of them shows, and it sets the figure.
 */
const BUTTON = 78;

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
const usePolled = <T,>(path: string, ask: (path: string) => Promise<T>) => {
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

    const timer = setInterval(again, 10_000);

    return () => clearInterval(timer);
  }, [again]);

  return { asked: state, again };
};
