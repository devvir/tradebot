import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Autocomplete, Badge, Button, Card, Group, Loader, Modal, MultiSelect, Progress,
  Select, Stack, Text, TextInput, Title,
} from '@mantine/core';
import { catalog, post, put, remove } from '../api';

/** The key a lens keeps its all-venue rules under — see the catalog's `GLOBAL`. */
const GLOBAL = '*';
import { bytes, count } from './Table';
import type {
  Lens, LensDefinition, LensOption, LensProblem, LensRule, LensSize,
} from '../types';

/**
 * Lenses: named ways of looking at the catalog.
 *
 * **Where a lens is in force, what it lets through is the catalog**, as far as
 * whoever looks through it is concerned. So this page is not a shopping list — it
 * is the definition of a view, and the thing it has to make obvious is what that
 * view leaves out.
 *
 * **Rules are ordered and they compose.** Each one either adds or takes away, and
 * later rules see what earlier ones left. That is what lets "everything up to a
 * date, except books, except recent trades" be three lines that read top to
 * bottom, rather than an enumeration of the complement.
 *
 * **A rule states only what it constrains.** Every dimension left empty means all
 * of it, which is shown as `every` rather than as a blank — because the
 * difference between "all datasets" and "no datasets chosen yet" is the whole
 * meaning of the rule.
 */
export const Lenses = () => {
  const [lenses, setLenses] = useState<Lens[] | null>(null);
  const [error,  setError]  = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);

  const load = useCallback(async (keep?: string) => {
    try {
      const { items } = await catalog<{ items: Lens[] }>('/lenses');

      setLenses(items);
      setError(null);
      setChosen(had => keep ?? (had && items.some(one => one.slug === had)
        ? had : items[0]?.slug ?? null));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const lens = lenses?.find(one => one.slug === chosen) ?? null;

  return (
    <Stack gap="md">
      {error && <Alert color="orange" variant="light" title="The catalog refused that">{error}</Alert>}

      <Group align="flex-end" gap="sm">
        <Select
          label="Lens"
          placeholder={lenses?.length ? 'Choose a lens' : 'No lenses yet'}
          data={(lenses ?? []).map(one => ({ value: one.slug, label: one.name || one.slug }))}
          value={chosen} onChange={setChosen} w={260}
        />
        <Button size="sm" variant="light" onClick={() => setNaming(true)}>New Lens</Button>
        {lenses === null && <Loader size="sm" type="dots" />}
      </Group>

      {lens && <Editing lens={lens} onChanged={load} onFailed={setError} />}

      <Naming
        opened={naming} onClose={() => setNaming(false)}
        onMade={name => { setNaming(false); load(name); }} onFailed={setError}
      />
    </Stack>
  );
};

/** How often an open lens asks its size again, so progress moves while hauling. */
const SIZE_REFRESH_MS = 30_000;

/**
 * How much of what the lens lets through is already on disk, by weight — files
 * vary from kilobytes to gigabytes, so a count would say little about the wait.
 */
const Downloaded = ({ size }: { size: LensSize }) => {
  const done  = size.bytes - size.pendingBytes;
  const share = size.bytes > 0 ? (done / size.bytes) * 100 : 0;

  return (
    <Group gap="xs" wrap="nowrap">
      <Progress value={share} w={180} size="sm" color={size.pending === 0 ? 'green' : 'cyan'} />
      <Text size="xs" c="dimmed"
        title={`${count(size.files - size.pending)} of ${count(size.files)} files downloaded`}>
        {bytes(done)} of {bytes(size.bytes)} downloaded · {share.toFixed(1)}%
      </Text>
    </Group>
  );
};

/** One lens, whole: what it is called, what it is for, and what it lets through. */
const Editing = ({ lens, onChanged, onFailed }: {
  lens:      Lens;
  onChanged: (keep?: string) => void;
  onFailed:  (message: string) => void;
}) => {
  const kept = keptFor(lens);

  const [name,  setName]  = useState(kept?.name ?? lens.name);
  const [note,  setNote]  = useState(kept?.note ?? lens.note);
  const [draft, setDraft] = useState<LensDefinition>(kept?.definition ?? lens.definition);
  const [going, setGoing] = useState(false);

  const [problems, setProblems] = useState<LensProblem[]>([]);
  const [size,     setSize]     = useState<LensSize | undefined>(undefined);
  const [venues,   setVenues]   = useState<string[]>([]);

  /**
   * **A lens changing under the editor replaces the draft.** Switching to another
   * lens, or saving this one, is a different document — and whatever was half
   * written belonged to the one before it.
   */
  useEffect(() => {
    const had = keptFor(lens);

    setName(had?.name ?? lens.name);
    setNote(had?.note ?? lens.note);
    setDraft(had?.definition ?? lens.definition);
  }, [lens.slug, lens.updatedAt]);

  useEffect(() => {
    catalog<{ items: { venue: string }[] }>('/contents/venues')
      .then(({ items }) => setVenues(items.map(one => one.venue)))
      .catch(() => setVenues([]));
  }, []);

  /**
   * **Asked of the catalog on every change**, by the same function that refuses
   * the write — so this page never has a second opinion about what is valid.
   */
  useEffect(() => {
    const at = setTimeout(() => {
      post<{ problems: LensProblem[] }>('/api/catalog/lenses/check', draft)
        .then(({ problems: found }) => setProblems(found)).catch(() => setProblems([]));

      setSize(undefined);
      post<LensSize>('/api/catalog/lenses/size', draft).then(setSize).catch(() => setSize(undefined));
    }, 250);

    return () => clearTimeout(at);
  }, [draft]);

  /**
   * **Progress moves while a downloader works**, so the size is asked again every
   * so often — quietly, keeping the last answer on screen until the next arrives.
   */
  useEffect(() => {
    const every = setInterval(() => {
      post<LensSize>('/api/catalog/lenses/size', draft).then(setSize).catch(() => undefined);
    }, SIZE_REFRESH_MS);

    return () => clearInterval(every);
  }, [draft]);

  const dirty = name !== lens.name || note !== lens.note
    || JSON.stringify(draft) !== JSON.stringify(lens.definition);

  /**
   * **A half-written lens survives a reload.** A rule list is minutes of work and
   * the page is a route, so a glance at the Contents tab, a refresh or a closed
   * laptop would otherwise take all of it. Kept against the version it was
   * written from, so a lens saved somewhere else replaces the draft rather than
   * silently reviving edits to a document that has moved on.
   */
  useEffect(() => {
    keep(lens, dirty ? { name, note, definition: draft, from: lens.updatedAt } : null);
  }, [lens.slug, lens.updatedAt, name, note, draft, dirty]);

  const save = () => {
    setGoing(true);
    put(`/api/catalog/lenses/${encodeURIComponent(lens.slug)}`, { name, note, definition: draft })
      .then(() => { keep(lens, null); onChanged(lens.slug); })
      .catch(err => onFailed((err as Error).message))
      .finally(() => setGoing(false));
  };

  const forVenue = (venue: string, rules: LensRule[]) =>
    setDraft(had => {
      const next = { ...had.venues };

      if (rules.length === 0) delete next[venue];
      else next[venue] = rules;

      return { ...had, venues: next };
    });

  /**
   * **Every venue has a block, whether or not it has rules.** A lens is written
   * by reading down the venues and saying what each one contributes, so the
   * question "what does bitget give this lens?" should be answerable by looking
   * rather than by finding a venue in a dropdown first — and "nothing" is an
   * answer the empty block gives and a missing block does not.
   *
   * **The draft's own keys are in it too.** A lens may name a venue this catalog
   * has no contents for yet; dropping its block would quietly discard rules that
   * are still stored.
   */
  const blocks = [...new Set([...venues, ...Object.keys(draft.venues)])]
    .filter(one => one !== GLOBAL).sort();

  /**
   * **The global block is always there.** A lens that says *everything up to
   * 2020* means it of every venue, and making that seven identical blocks is a
   * worse lie than an empty one — so the block exists whether or not it holds
   * rules, and cannot be taken away.
   */
  const global = draft.venues[GLOBAL] ?? [];

  return (
    <Stack gap="md">
      <Group align="flex-end" gap="sm" wrap="nowrap">
        <TextInput
          label="Name" value={name} w={240} placeholder={lens.slug}
          onChange={event => setName(event.currentTarget.value)}
        />
        <TextInput
          label="What it is for" value={note} w={420}
          onChange={event => setNote(event.currentTarget.value)}
        />
        {/*
          When it was last saved belongs to the button that saves it: it is the
          answer to "have I saved this?", which is asked of the control, and a
          line of its own gave a date equal weight with the lens' own name.
        */}
        <Button
          size="sm" color="green" disabled={! dirty || going} onClick={save}
          title={`Last saved: ${lens.updatedAt.slice(0, 16).replace('T', ' ')}`}
        >Save</Button>

        {/*
          Back to what is stored, discarding the draft. The draft outlives a
          reload by design, so without this an unwanted edit could only be saved.
        */}
        <Button
          size="compact-xs" variant="subtle" color="gray" disabled={! dirty || going} mb={6}
          title="Discard every change since the last save"
          onClick={() => { setName(lens.name); setNote(lens.note); setDraft(lens.definition); keep(lens, null); }}
        >Reload as saved</Button>
        <Removing lens={lens} onGone={() => onChanged()} onFailed={onFailed} />
      </Group>

      {problems.length > 0 && (
        <Alert color="orange" variant="light" title="This lens cannot be stored as it is">
          <Stack gap={4}>
            {problems.map((one, at) => (
              <Text size="sm" key={at}>
                {one.venue}{one.rule >= 0 ? ` · rule ${one.rule + 1}` : ''} — {one.message}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}

      <Group justify="flex-end" align="flex-end">
        <Stack gap={4} align="flex-end">
          <Group gap="xs">
            <Text size="sm" c="dimmed">Everything this lens lets through:</Text>
            {size === undefined ? <Loader size="xs" type="dots" /> : (
              <Text size="sm" fw={600}
                title={`${count(size.files)} files over ${count(size.series)} series`}>
                {bytes(size.bytes)}
              </Text>
            )}
          </Group>
          {size !== undefined && size.files > 0 && typeof size.pendingBytes === 'number' && <Downloaded size={size} />}
        </Stack>
      </Group>

      <ForVenue
        venue={GLOBAL} rules={global}
        problems={problems.filter(one => one.venue === GLOBAL)}
        onChanged={next => forVenue(GLOBAL, next)}
      />

      {blocks.map(venue => (
        <ForVenue
          key={venue} venue={venue} rules={draft.venues[venue] ?? []}
          problems={problems.filter(one => one.venue === venue)}
          onChanged={next => forVenue(venue, next)}
        />
      ))}

    </Stack>
  );
};

/**
 * What is half written, against the version of the lens it was written from.
 *
 * **Per lens and per version.** A draft against a document somebody else has
 * since saved is edits to a thing that no longer exists, and reviving it would
 * quietly undo their change.
 */
interface Draft {
  name:       string;
  note:       string;
  definition: LensDefinition;
  from:       string;
}

const drafted = (slug: string) => `catalog-ui.lens-draft.${slug}`;

const keptFor = (lens: Lens): Draft | null => {
  try {
    const had = localStorage.getItem(drafted(lens.slug));

    if (had === null) return null;

    const draft = JSON.parse(had) as Draft;

    return draft.from === lens.updatedAt ? draft : null;
  } catch {
    return null;
  }
};

const keep = (lens: Lens, draft: Draft | null): void => {
  try {
    if (draft === null) localStorage.removeItem(drafted(lens.slug));
    else localStorage.setItem(drafted(lens.slug), JSON.stringify(draft));
  } catch {
    // A browser refusing storage is not a reason to stop editing.
  }
};

/** One venue's rules, in the order they are applied. */
const ForVenue = ({ venue, rules, problems, onChanged }: {
  venue:     string;
  rules:     LensRule[];
  problems:  LensProblem[];
  onChanged: (rules: LensRule[]) => void;
}) => {
  const [offered, setOffered] = useState<LensOption[]>([]);
  const [symbols, setSymbols] = useState<string[]>([]);

  useEffect(() => {
    catalog<{ items: LensOption[] }>(`/lenses/options/${encodeURIComponent(venue)}`)
      .then(({ items }) => setOffered(items)).catch(() => setOffered([]));

    /**
     * **The whole list, once.** A venue has thousands of instruments and the
     * search is three characters deep, so filtering here costs nothing and asking
     * the catalog on every keystroke would cost a request each.
     *
     * From the lens endpoint rather than the contents one, because a lens can be
     * written about every venue at once and `*` is not a venue anything else
     * knows about.
     */
    catalog<{ items: string[] }>(`/lenses/instruments/${encodeURIComponent(venue)}`)
      .then(({ items }) => setSymbols(items)).catch(() => setSymbols([]));
  }, [venue]);

  const at = (index: number, to: LensRule) =>
    onChanged(rules.map((one, each) => (each === index ? to : one)));

  return (
    <Card withBorder padding="md" radius="sm">
      <Stack gap="sm">
        <Group justify="space-between" align="baseline">
          <Group gap="xs" align="baseline">
            <Title order={2} size="h6" tt={venue === GLOBAL ? undefined : 'uppercase'}>
              {venue === GLOBAL ? 'All venues' : venue}
            </Title>
            {venue === GLOBAL
              ? (
                <Text size="xs" c="dimmed" fs="italic">
                  applied to every venue, before that venue&rsquo;s own rules
                </Text>
              )
              : (
                <Button
                  size="compact-xs" variant="subtle" color="red" opacity={0.55}
                  disabled={rules.length === 0}
                  title={`Clear every rule ${venue} has in this lens`}
                  onClick={() => onChanged([])}
                >Clear</Button>
              )}
          </Group>
          <Button size="compact-xs" variant="subtle"
            onClick={() => onChanged([...rules, { effect: 'include' }])}>Add rule</Button>
        </Group>

        {rules.map((rule, index) => (
          <Rule
            key={index} rule={rule} offered={offered} symbols={symbols}
            problems={problems.filter(one => one.rule === index)}
            onChanged={to => at(index, to)}
            onRemoved={() => onChanged(rules.filter((_, each) => each !== index))}
          />
        ))}
      </Stack>
    </Card>
  );
};

/**
 * One rule, in two rows.
 *
 * **What it does, then what it is about.** The first row is the sentence — this
 * rule includes or excludes, between these dates — and the second is everything
 * it is narrowed by. Six controls in a line read as six equal choices, when one
 * of them decides what the other five mean.
 *
 * **Every list left empty is shown as `every`**, because a rule that constrains
 * nothing is the common case and an empty box reads as unfinished.
 */
const Rule = ({ rule, offered, symbols, problems, onChanged, onRemoved }: {
  rule:      LensRule;
  offered:   LensOption[];
  symbols:   string[];
  problems:  LensProblem[];
  onChanged: (rule: LensRule) => void;
  onRemoved: () => void;
}) => {
  const markets = useMemo(() => [...new Set(offered.map(one => one.market))].sort(), [offered]);
  const grains  = useMemo(() => [...new Set(offered.map(one => one.grain))].sort(), [offered]);

  /**
   * **A variant has no meaning apart from its dataset**, so the two are one
   * choice: `klines (1m)` rather than `klines` beside a `1m` that might belong to
   * anything. The bare dataset — every variant of it — is offered only where
   * there is more than one to choose between, since otherwise it says nothing the
   * dataset does not already say.
   */
  const datasets = useMemo(() => {
    const byDataset = new Map<string, Set<string>>();

    for (const one of offered) {
      const had = byDataset.get(one.dataset) ?? new Set<string>();

      had.add(one.variant);
      byDataset.set(one.dataset, had);
    }

    return [...byDataset.entries()].sort().flatMap(([dataset, variants]) => {
      const each = [...variants].filter(Boolean).sort(byPeriod);

      if (each.length < 2) return [{ value: dataset, label: dataset }];

      return [
        { value: dataset, label: `${dataset} (any)` },
        ...each.map(one => ({ value: `${dataset}\u0000${one}`, label: `${dataset} (${one})` })),
      ];
    });
  }, [offered]);

  /**
   * **The control and the rule say the same thing**, so this is a spelling change
   * rather than a translation: one entry is one `{ dataset, variant? }`.
   */
  const chosen = useMemo(
    () => (rule.datasets ?? []).map(one =>
      (one.variant === undefined ? one.dataset : `${one.dataset}\u0000${one.variant}`)),
    [rule.datasets]);

  const pick = (values: string[]) => {
    const picked = values.map(one => {
      const [dataset, variant] = one.split('\u0000');

      return variant === undefined ? { dataset: dataset! } : { dataset: dataset!, variant };
    });

    onChanged({ ...rule, datasets: picked.length === 0 ? undefined : picked });
  };

  const wrong = (field: keyof LensRule) => problems.find(one => one.field === field)?.message;

  const set = (field: 'markets' | 'grains') => (values: string[]) =>
    onChanged({ ...rule, [field]: values.length === 0 ? undefined : values });

  return (
    <Card withBorder padding="sm" radius="sm" bg="var(--mantine-color-default)">
      <Stack gap="xs">
        <Group justify="space-between" align="flex-end" wrap="nowrap">
          <Select
            label="Action" w={130} allowDeselect={false}
            data={[{ value: 'include', label: 'Include' }, { value: 'exclude', label: 'Exclude' }]}
            value={rule.effect}
            onChange={effect => onChanged({ ...rule, effect: effect as LensRule['effect'] })}
          />
          <Group gap="xs" align="flex-end" wrap="nowrap">
            <Month
              label="From" value={rule.from} error={wrong('from')}
              onChanged={from => onChanged({ ...rule, from })}
            />
            <Month
              label="To" value={rule.to} error={wrong('to')}
              onChanged={to => onChanged({ ...rule, to })}
            />
          </Group>
        </Group>

        <Group align="flex-start" gap="sm" grow wrap="nowrap">
          <MultiSelect
            w={230} label="Markets" placeholder={(rule.markets ?? []).length === 0 ? 'All' : ''}
            data={markets} value={rule.markets ?? []} error={wrong('markets')}
            searchable clearable onChange={set('markets')}
          />
          <MultiSelect
            w={260} label="Datasets" placeholder={chosen.length === 0 ? 'All' : ''}
            data={datasets} value={chosen} error={wrong('datasets')}
            searchable clearable onChange={pick}
          />
          <MultiSelect
            w={200} label="Grains" placeholder={(rule.grains ?? []).length === 0 ? 'All' : ''}
            data={grains} value={rule.grains ?? []} error={wrong('grains')}
            searchable clearable onChange={set('grains')}
          />
        </Group>

        <Instruments
          chosen={rule.instruments ?? []} symbols={symbols} error={wrong('instruments')}
          buckets={offered.some(one => one.buckets > 0)}
          onChanged={values => onChanged({
            ...rule, instruments: values.length === 0 ? undefined : values,
          })}
        />

        <Group justify="flex-end">
          <Button size="compact-xs" variant="subtle" color="gray" title="Take this rule out" onClick={onRemoved}>
            Drop Rule
          </Button>
        </Group>
      </Stack>
    </Card>
  );
};

/**
 * Variants in the order a person reads them.
 *
 * **A bar length is not a word.** Sorted as text, a kline's variants come out
 * `10s, 12h, 15m, 1d, 1h, 1m, 1mo…`, which is nobody's idea of ascending. So
 * anything shaped like a period is ordered by how long it is, and anything else
 * falls back to the alphabet — a book depth has no duration and `400` beside
 * `full` sorts the only way it can.
 *
 * **Recognised by shape rather than by a list of datasets**, because the shape is
 * the fact: four datasets use bar lengths today and the fifth will not need
 * adding anywhere.
 */
const byPeriod = (a: string, b: string): number => {
  const one = seconds(a), two = seconds(b);

  if (one !== null && two !== null) return one - two;
  if (one !== null) return -1;
  if (two !== null) return 1;

  return a.localeCompare(b);
};

/** A variant as a duration, or null where it is not one. */
const seconds = (variant: string): number | null => {
  const had = /^(\d+)(s|m|h|d|w|mo|y)$/.exec(variant);

  if (! had) return null;

  return Number(had[1]) * SPANS[had[2] as keyof typeof SPANS];
};

const SPANS = {
  s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800, mo: 2_592_000, y: 31_536_000,
} as const;

/**
 * The instruments a rule names, as a search and a row of badges.
 *
 * **A list of thousands is not a dropdown.** A venue lists more instruments than
 * anyone scrolls, so this is a search that stays quiet until three characters
 * make it worth answering — and what has been chosen sits beside it, where it can
 * be read at a glance and taken off one at a time.
 *
 * **Five, then a count.** A rule naming forty instruments is a legitimate rule
 * and an unreadable row, so the rest go behind a number that carries them in its
 * tooltip.
 */
const Instruments = ({ chosen, symbols, error, buckets, onChanged }: {
  chosen:    string[];
  symbols:   string[];
  error?:    string;

  /** Whether the venue publishes any venue-wide file — Buckets is only offered where it does. */
  buckets:   boolean;
  onChanged: (chosen: string[]) => void;
}) => {
  const [query, setQuery] = useState('');

  /**
   * **Three characters before anything is offered.** Below that every list is
   * the whole list, which is a dropdown nobody can use and a page that stutters
   * rendering it.
   */
  const matches = useMemo(() => {
    if (query.trim().length < 3) return [];

    const looking = query.trim().toUpperCase();

    return symbols
      .filter(one => one.toUpperCase().includes(looking) && ! chosen.includes(one))
      .slice(0, 20);
  }, [query, symbols, chosen]);

  /** Buckets is a single thing rather than one of many, so it is counted apart. */
  const named  = chosen.filter(one => one !== BUCKET);
  const shown  = chosen.slice(0, 5);
  const beyond = chosen.slice(5);

  return (
    <Group align="flex-end" gap="sm" wrap="nowrap">
      <Autocomplete
        label="Instruments" w={320} value={query} data={matches} error={error}
        placeholder={placeholderFor(chosen, named)}
        onChange={setQuery}
        onOptionSubmit={one => {
          onChanged([...chosen, one]);

          /**
           * **Cleared on the tick after the pick.** Mantine writes the chosen
           * option back into the field as part of submitting it, so clearing in
           * the same turn is undone by the component itself.
           */
          setTimeout(() => setQuery(''), 0);
        }}
      />

      <Group gap={6} wrap="wrap" pb={6}>
        {buckets && ! chosen.includes(BUCKET) && (
          <Button
            size="compact-xs" variant="subtle" color="teal"
            title={'The venue-wide file: one file holding every instrument of a market, '
                 + 'rather than one file per instrument'}
            onClick={() => onChanged([...chosen, BUCKET])}
          >Buckets</Button>
        )}

        {shown.map(one => (
          <Badge
            key={one} variant="light" color={one === BUCKET ? 'teal' : 'blue'}
            style={{ cursor: 'pointer' }} rightSection={<Cross />}
            title={one === BUCKET
              ? 'Buckets — the venue-wide file. Click to remove'
              : `Remove ${one}`}
            onClick={() => onChanged(chosen.filter(each => each !== one))}
          >{one === BUCKET ? 'Buckets' : one}</Badge>
        ))}

        {beyond.length > 0 && (
          <Badge variant="default" title={beyond.join(', ')}>+{beyond.length}</Badge>
        )}
      </Group>
    </Group>
  );
};

/** The venue-wide file. Not in any venue's instrument list, and always offerable. */
const BUCKET = '@';

/**
 * What the field says about what is already chosen.
 *
 * **Buckets alone is a real selection, not an empty one.** Left saying *find
 * another* it reads as though more of them were expected, when there is exactly
 * one bucket per market and nothing else to add unless a named instrument is
 * wanted beside it.
 */
const placeholderFor = (chosen: readonly string[], named: readonly string[]): string => {
  if (chosen.length === 0) return 'All — or type 3 letters';

  if (named.length === 0) return 'Only buckets — or add instruments';

  return 'Add another';
};

/**
 * A bound, which is a month.
 *
 * **A day would be a false precision.** Nobody collects up to the 14th, and a
 * file dated `202006` covers all of June — so a day bound cannot halve it and the
 * two ends of a range would stop meaning the same thing. The browser's own month
 * control says exactly this and costs no dependency.
 *
 * It speaks `yyyy-mm` and the catalog stores `yyyymm`, which is the whole of the
 * translation.
 */
const Month = ({ label, value, error, onChanged }: {
  label:     string;
  value?:    string;
  error?:    string;
  onChanged: (value: string | undefined) => void;
}) => {
  /**
   * **An unset bound is open, and a month control cannot say so.** Empty, it
   * renders as its own punctuation — `---- --` — which reads as broken rather
   * than as *no limit in this direction*. So it is a plain field saying `Open`
   * until it is focused, and the month control from then on.
   */
  const [picking, setPicking] = useState(false);

  if (value === undefined && ! picking)
    return (
      <TextInput
        label={label} w={185} error={error} value="" placeholder="Open" readOnly
        onFocus={() => setPicking(true)}
      />
    );

  return (
    <TextInput
      type="month" label={label} w={185} error={error} autoFocus={picking && ! value}
      value={value ? `${value.slice(0, 4)}-${value.slice(4, 6)}` : ''}
      onBlur={() => setPicking(false)}
      onChange={event => {
        const had = event.currentTarget.value;

        onChanged(had ? had.replace('-', '') : undefined);
      }}
    />
  );
};

const Cross = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <path d="M3.5 3.5l9 9m0-9l-9 9" />
  </svg>
);

const Trash = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M2.5 4h11M6 4V2.6h4V4M4 4l.7 9.4h6.6L12 4" />
    <path d="M6.6 6.6v4.6M9.4 6.6v4.6" />
  </svg>
);

const Removing = ({ lens, onGone, onFailed }: {
  lens: Lens; onGone: () => void; onFailed: (message: string) => void;
}) => {
  const [asking, setAsking] = useState(false);

  return (
    <>
      <Button
        size="sm" variant="light" color="red" ml="auto" leftSection={<Trash />}
        title={`Delete the lens "${lens.name || lens.slug}"`} onClick={() => setAsking(true)}
      >Delete</Button>
      <Modal opened={asking} onClose={() => setAsking(false)} centered
        title={`Delete the lens "${lens.name || lens.slug}"?`}>
        <Stack gap="md">
          <Text size="sm">
            Nothing already downloaded is touched — a lens says what a consumer sees,
            not what is held.
          </Text>
          <Group justify="flex-end">
            <Button size="xs" variant="default" onClick={() => setAsking(false)}>Cancel</Button>
            <Button size="xs" color="red" onClick={() => {
              setAsking(false);
              remove(`/api/catalog/lenses/${encodeURIComponent(lens.slug)}`)
                .then(onGone).catch(err => onFailed((err as Error).message));
            }}>Delete</Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
};

const Naming = ({ opened, onClose, onMade, onFailed }: {
  opened:   boolean;
  onClose:  () => void;
  onMade:   (slug: string) => void;
  onFailed: (message: string) => void;
}) => {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => { if (opened) { setSlug(''); setName(''); setNote(''); } }, [opened]);

  /**
   * **The address follows the name until it is touched.** Most lenses want the
   * obvious slug, and typing the same words twice is the kind of friction that
   * makes people accept whatever was offered.
   */
  const [own, setOwn] = useState(false);

  const suggested = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 64);

  const addressed = own ? slug : suggested;

  return (
    <Modal opened={opened} onClose={onClose} title="New lens" centered>
      <Stack gap="md">
        <TextInput
          label="Name" placeholder="Cold store" value={name}
          description="What you will call it"
          inputWrapperOrder={['label', 'input', 'description', 'error']}
          onChange={event => setName(event.currentTarget.value)}
        />
        <TextInput
          label="Address" placeholder="cold-store" value={addressed}
          description="What a consumer asks for: lower case, digits and hyphens"
          inputWrapperOrder={['label', 'input', 'description', 'error']}
          onChange={event => {
            setOwn(true);
            setSlug(event.currentTarget.value.trim().toLowerCase());
          }}
        />
        <TextInput label="What it is for" value={note}
          onChange={event => setNote(event.currentTarget.value)} />
        <Group justify="flex-end">
          <Button size="xs" variant="default" onClick={onClose}>Cancel</Button>
          <Button size="xs" disabled={addressed.length < 2} onClick={() => {
            post<Lens>('/api/catalog/lenses', { slug: addressed, name: name.trim(), note })
              .then(made => onMade(made.slug))
              .catch(err => onFailed((err as Error).message));
          }}>Create</Button>
        </Group>
      </Stack>
    </Modal>
  );
};
