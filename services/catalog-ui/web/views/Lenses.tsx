import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Autocomplete, Badge, Button, Card, Group, Loader, Modal, MultiSelect, Progress,
  Select, Stack, Text, TextInput, Title,
} from '@mantine/core';
import { catalog, poll, remove, send } from '../api';
import { linkTo, rememberLens } from '../App';
import { bytes, count } from './Table';
import type {
  Lens, LensDefinition, LensDraft, LensOption, LensProblem, LensRule, LensSize, RuleEntry,
} from '../types';

/** The key a lens keeps its all-venue rules under — see the catalog's `GLOBAL`. */
const GLOBAL = '*';

/**
 * Lenses: named ways of looking at the catalog.
 *
 * **Where a lens is in force, what it lets through is the catalog**, as far as
 * whoever looks through it is concerned. So this page is not a shopping list — it
 * is the definition of a view, and the thing it has to make obvious is what that
 * view leaves out.
 *
 * **Includes minus excludes, in no order.** A lens lets through what any include
 * matches, less what any exclude matches; where a rule sits never changes that.
 *
 * **A rule is confirmed on its own.** Writing one sends nothing; Confirm stores
 * the lens with that rule, Drop stores it without, and Save is for the name and
 * the note alone — so a half-written rule never costs the catalog a request, and
 * each change that reaches it is one somebody meant.
 *
 * **A rule states only what it constrains.** Every dimension left empty means all
 * of it, which is shown as `every` rather than as a blank — because the
 * difference between "all datasets" and "no datasets chosen yet" is the whole
 * meaning of the rule.
 */
export const Lenses = ({ slug }: { slug?: string | undefined }) => {
  const [lenses, setLenses] = useState<Lens[] | null>(null);
  const [error,  setError]  = useState<string | null>(null);
  const [naming, setNaming] = useState(false);

  /**
   * **A new lens is the page's until it is first saved** — by Save, or by its
   * first confirmed rule. Kept in this browser, so a reload does not lose it.
   */
  const [fresh, setFresh] = useState<Lens | null>(unsavedLens);

  /**
   * **The lens being edited is the address**, `#lenses/:slug`, so a link opens
   * it, back and forward move between lenses, and the lenses tab returns to
   * the one last opened.
   */
  const open = (to: string) => { location.hash = linkTo({ section: 'lenses', lens: to }).slice(1); };

  const load = useCallback(async (keep?: string) => {
    try {
      const { items } = await catalog<{ items: Lens[] }>('/lenses');

      setLenses(items);
      setError(null);

      if (keep) open(keep);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const lens = lenses?.find(one => one.slug === slug) ?? (fresh?.slug === slug ? fresh : null);

  /** Once stored, a new lens is the catalog's: the page forgets its own copy. */
  const stored = (made: string) => {
    if (fresh?.slug === made) { setFresh(null); keepUnsaved(null); }

    load(made);
  };

  /**
   * **An address naming no lens that exists opens the first one instead**, in
   * place rather than as a step in the history — a deleted lens, an old link, or
   * the bare section.
   */
  useEffect(() => {
    if (lenses === null || lens) return;

    const first = fresh?.slug ?? lenses[0]?.slug;

    if (first) location.replace(linkTo({ section: 'lenses', lens: first }));
  }, [lenses, lens]);

  useEffect(() => { if (lens && lens.id !== undefined) rememberLens(lens.slug); }, [lens]);

  const choices = [
    ...(fresh && ! lenses?.some(one => one.slug === fresh.slug) ? [fresh] : []),
    ...(lenses ?? []),
  ];

  return (
    <Stack gap="md">
      {error && <Alert color="orange" variant="light" title="The catalog refused that">{error}</Alert>}

      <Group align="flex-end" gap="sm">
        <Select
          label="Lens"
          placeholder={choices.length ? 'Choose a lens' : 'No lenses yet'}
          data={choices.map(one => ({
            value: one.slug,
            label: `${one.name || one.slug}${one.id === undefined ? ' (not saved)' : ''}`,
          }))}
          value={lens?.slug ?? null} onChange={to => { if (to) open(to); }} w={260}
          allowDeselect={false}
        />
        <Button size="sm" variant="light" onClick={() => setNaming(true)}>New Lens</Button>
        {lenses === null && <Loader size="sm" type="dots" />}
      </Group>

      {lens && (
        <Editing
          key={lens.slug} lens={lens} onStored={stored} onFailed={setError}
          onGone={() => { if (lens.id === undefined) { setFresh(null); keepUnsaved(null); } load(); }}
        />
      )}

      <Naming
        opened={naming} taken={choices.map(one => one.slug)} onClose={() => setNaming(false)}
        onNamed={made => { setNaming(false); setFresh(made); keepUnsaved(made); open(made.slug); }}
      />
    </Stack>
  );
};

/** How often an open lens asks its size again, so progress moves while hauling. */
const SIZE_REFRESH_MS = 30_000;

/** Where a lens's last known size is kept, one entry per lens. */
const sizeKey = (slug: string): string => `catalog-ui:lens-size:${slug}`;

/** The size last seen for exactly this saved lens, or undefined where it was never sized here. */
const seenSize = (lens: Lens): LensSize | undefined => {
  try {
    const held = JSON.parse(localStorage.getItem(sizeKey(lens.slug)) ?? 'null') as
      { updatedAt: string; size: LensSize } | null;

    return held && held.updatedAt === lens.updatedAt ? held.size : undefined;
  } catch {
    return undefined;
  }
};

const keepSize = (lens: Lens, size: LensSize): void => {
  try {
    localStorage.setItem(sizeKey(lens.slug), JSON.stringify({ updatedAt: lens.updatedAt, size }));
  } catch { /* storage refused: the next visit waits for the answer instead */ }
};

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
const Editing = ({ lens, onStored, onFailed, onGone }: {
  lens:     Lens;
  onStored: (slug: string) => void;
  onFailed: (message: string) => void;
  onGone:   () => void;
}) => {
  const unsaved = lens.id === undefined;
  const kept    = keptFor(lens);

  const [name,  setName]  = useState(kept?.name ?? lens.name);
  const [note,  setNote]  = useState(kept?.note ?? lens.note);
  const [rules, setRules] = useState<Record<string, RuleEntry[]>>(kept?.rules ?? entriesOf(lens.definition));

  /** The rule being stored, by its key — its buttons wait, and only one store runs at a time. */
  const [storing,  setStoring]  = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, LensProblem[]>>({});
  const [general,  setGeneral]  = useState<LensProblem[]>([]);

  const [size,   setSize]   = useState<LensSize | undefined>(unsaved ? undefined : seenSize(lens));
  const [venues, setVenues] = useState<string[]>([]);

  useEffect(() => {
    const asked = new AbortController();

    catalog<{ items: { venue: string }[] }>('/contents/venues', asked.signal)
      .then(({ items }) => setVenues(items.map(one => one.venue)))
      .catch(() => undefined);

    return () => asked.abort();
  }, []);

  /**
   * **The size is the saved lens's**, never a draft's: shown at once from what
   * this browser last saw for this version, asked right away, and again
   * `SIZE_REFRESH_MS` after each answer, since progress moves while a downloader
   * works. A confirm or a drop asks again at once. A lens not yet saved has none.
   */
  const sizing = useRef<{ now: () => void; stop: () => void }>(undefined);

  useEffect(() => {
    if (unsaved) return;

    setSize(seenSize(lens));

    sizing.current = poll(
      signal => catalog<LensSize>(`/lenses/${encodeURIComponent(lens.slug)}/size`, signal),
      SIZE_REFRESH_MS,
      { data: found => { setSize(found); keepSize(lens, found); } },
    );

    return () => sizing.current?.stop();
  }, [lens.slug, lens.updatedAt, unsaved]);

  const general_dirty = name !== lens.name || note !== lens.note;

  /** Any rule not as stored: a draft never confirmed, or a confirmed one edited since. */
  const drafting = Object.values(rules).some(list => list.some(one => stateOf(one) !== 'saved'));

  /**
   * **What is unsaved survives a reload** — drafts of rules and edits to the name
   * and note — kept against the version of the lens it was written from, so a
   * lens saved somewhere else replaces it rather than having edits revived on a
   * document that has moved on.
   */
  useEffect(() => {
    keep(lens, general_dirty || drafting ? { name, note, rules, from: lens.updatedAt } : null);
  }, [lens.slug, lens.updatedAt, name, note, rules, general_dirty, drafting]);

  /**
   * Store the lens with these rules — creating it first where it is not saved
   * yet, with the name and the note it was given. On a saved lens only the rules
   * are sent: an unsaved name or note stays unsaved, for Save.
   *
   * The catalog checks what it stores, so a rule it refuses comes back with its
   * problems and stays as it is on the page.
   */
  const store = async (key: string, definition: LensDefinition, after: (stored: Lens) => void) => {
    setStoring(key);

    try {
      const { status, body } = unsaved
        ? await send<Lens & { problems?: LensProblem[]; error?: string }>('/api/catalog/lenses', 'POST',
          { slug: lens.slug, name: name.trim(), note, definition })
        : await send<Lens & { problems?: LensProblem[]; error?: string }>(
          `/api/catalog/lenses/${encodeURIComponent(lens.slug)}`, 'PUT', { definition });

      if (status >= 400) {
        const found = body.problems ?? [];

        setProblems(had => ({ ...had, [key]: found.filter(one => one.rule >= 0) }));
        setGeneral(found.filter(one => one.rule < 0));

        if (found.length === 0) onFailed(body.error ?? `The catalog answered ${status}`);

        return;
      }

      setProblems(had => { const next = { ...had }; delete next[key]; return next; });
      setGeneral([]);
      after(body);

      if (unsaved) onStored(lens.slug);
      else { sizing.current?.now(); onStored(lens.slug); }
    } catch (err) {
      onFailed((err as Error).message);
    } finally {
      setStoring(null);
    }
  };

  /** The lens as stored, with one entry's draft in place of — or beside — what it was. */
  const withOne = (venue: string, entry: RuleEntry, drop = false): LensDefinition => {
    const out: LensDefinition['venues'] = {};

    for (const [each, list] of Object.entries({ ...rules, [venue]: rules[venue] ?? [] })) {
      const kept = list.flatMap(one => {
        if (one.key === entry.key) return drop ? [] : [one.now];

        return one.saved ? [one.saved] : [];
      });

      if (kept.length > 0) out[each] = kept;
    }

    return { format: 1, venues: out };
  };

  const confirm = (venue: string, entry: RuleEntry) =>
    store(entry.key, withOne(venue, entry), () => edit(venue, entry.key, one => ({ ...one, saved: one.now })));

  const drop = (venue: string, entry: RuleEntry) =>
    store(entry.key, withOne(venue, entry, true), () => remove_(venue, entry.key));

  const edit = (venue: string, key: string, change: (one: RuleEntry) => RuleEntry) =>
    setRules(had => ({ ...had, [venue]: (had[venue] ?? []).map(one => (one.key === key ? change(one) : one)) }));

  const remove_ = (venue: string, key: string) =>
    setRules(had => ({ ...had, [venue]: (had[venue] ?? []).filter(one => one.key !== key) }));

  /** Store the lens without any of this venue's rules, and forget its drafts. */
  const clear = (venue: string) => {
    const out = withOne(venue, { key: '', now: { effect: 'include' } }, true);

    delete out.venues[venue];

    return store(`clear:${venue}`, out, () => setRules(had => { const next = { ...had }; delete next[venue]; return next; }));
  };

  const add = (venue: string) =>
    setRules(had => ({ ...had, [venue]: [...(had[venue] ?? []), { key: freshKey(), now: { effect: 'include' } }] }));

  /** Save: the name and the note. On a lens not saved yet, the lens itself, with the rules confirmed so far — none. */
  const save = () =>
    unsaved
      ? store('', { format: 1, venues: {} }, () => undefined)
      : send(`/api/catalog/lenses/${encodeURIComponent(lens.slug)}`, 'PUT', { name, note })
        .then(({ status, body }) => {
          if (status >= 400) onFailed((body as { error?: string }).error ?? `The catalog answered ${status}`);
          else onStored(lens.slug);
        })
        .catch(err => onFailed((err as Error).message));

  /**
   * **Every venue has a block, whether or not it has rules.** A lens is written
   * by reading down the venues and saying what each one contributes, so the
   * question "what does bitget give this lens?" should be answerable by looking
   * rather than by finding a venue in a dropdown first — and "nothing" is an
   * answer the empty block gives and a missing block does not.
   *
   * **The lens's own keys are in it too.** A lens may name a venue this catalog
   * has no contents for yet; dropping its block would quietly hide rules that
   * are still stored.
   */
  const blocks = [...new Set([...venues, ...Object.keys(rules)])].filter(one => one !== GLOBAL).sort();

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
          answer to "have I saved this?", which is asked of the control.
        */}
        <Button
          size="sm" color="green" disabled={(! general_dirty && ! unsaved) || storing !== null} onClick={save}
          title={unsaved ? 'Not saved yet' : `Last saved: ${lens.updatedAt.slice(0, 16).replace('T', ' ')}`}
        >Save</Button>

        {/*
          Back to what is stored, discarding every draft — of the name, the note
          and the rules. Shown only where there is something to discard, and never
          on a lens not stored yet: there is nothing to reload it from.
        */}
        {! unsaved && (general_dirty || drafting) && (
          <Button
            size="compact-xs" variant="subtle" color="gray" mb={6} disabled={storing !== null}
            title="Discard every unsaved change: name, note and rules"
            onClick={() => { setName(lens.name); setNote(lens.note); setRules(entriesOf(lens.definition)); keep(lens, null); }}
          >Reload as saved</Button>
        )}
        <Removing lens={lens} onGone={onGone} onFailed={onFailed} />
      </Group>

      {general.length > 0 && (
        <Alert color="orange" variant="light" title="The catalog would not store that">
          <Stack gap={4}>
            {general.map((one, at) => <Text size="sm" key={at}>{one.venue} — {one.message}</Text>)}
          </Stack>
        </Alert>
      )}

      {! unsaved && (
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
      )}

      {[GLOBAL, ...blocks].map(venue => (
        <ForVenue
          key={venue} venue={venue} entries={rules[venue] ?? []}
          problems={problems} storing={storing}
          onAdd={() => add(venue)}
          onClear={() => {
            if (window.confirm(`Store this lens without any of ${venue === GLOBAL ? 'the all-venue' : `${venue}'s`} rules?`))
              void clear(venue);
          }}
          onEdit={(key, rule) => edit(venue, key, one => ({ ...one, now: rule }))}
          onConfirm={entry => void confirm(venue, entry)}
          onDrop={entry => void drop(venue, entry)}
          onDiscard={entry => (entry.saved
            ? edit(venue, entry.key, one => ({ ...one, now: one.saved! }))
            : remove_(venue, entry.key))}
        />
      ))}
    </Stack>
  );
};

/** Where a rule stands: never confirmed, confirmed and edited since, or as stored. */
const stateOf = (entry: RuleEntry): 'new' | 'changed' | 'saved' =>
  (! entry.saved ? 'new' : JSON.stringify(entry.saved) === JSON.stringify(entry.now) ? 'saved' : 'changed');

/** A stored definition as the editor holds it: every rule saved, none drafted. */
const entriesOf = (definition: LensDefinition): Record<string, RuleEntry[]> =>
  Object.fromEntries(Object.entries(definition.venues ?? {})
    .map(([venue, list]) => [venue, list.map(rule => ({ key: freshKey(), saved: rule, now: rule }))]));

let keys = 0;

const freshKey = (): string => `r${Date.now().toString(36)}${(keys++).toString(36)}`;

const drafted = (slug: string) => `catalog-ui.lens-draft.${slug}`;

const keptFor = (lens: Lens): LensDraft | null => {
  try {
    const had = localStorage.getItem(drafted(lens.slug));

    if (had === null) return null;

    const draft = JSON.parse(had) as LensDraft;

    return draft.from === lens.updatedAt && draft.rules ? draft : null;
  } catch {
    return null;
  }
};

const keep = (lens: Lens, draft: LensDraft | null): void => {
  try {
    if (draft === null) localStorage.removeItem(drafted(lens.slug));
    else localStorage.setItem(drafted(lens.slug), JSON.stringify(draft));
  } catch {
    // A browser refusing storage is not a reason to stop editing.
  }
};

const UNSAVED = 'catalog-ui.lens-unsaved';

/** The new lens not saved yet, if any, as this browser kept it. */
const unsavedLens = (): Lens | null => {
  try {
    return JSON.parse(localStorage.getItem(UNSAVED) ?? 'null') as Lens | null;
  } catch {
    return null;
  }
};

const keepUnsaved = (lens: Lens | null): void => {
  try {
    if (lens === null) localStorage.removeItem(UNSAVED);
    else localStorage.setItem(UNSAVED, JSON.stringify(lens));
  } catch { /* storage refused: the new lens lasts as long as the page */ }
};

/** One venue's rules — or every venue's, under `*`. */
const ForVenue = ({ venue, entries, problems, storing, onAdd, onClear, onEdit, onConfirm, onDrop, onDiscard }: {
  venue:     string;
  entries:   RuleEntry[];
  problems:  Record<string, LensProblem[]>;
  storing:   string | null;
  onAdd:     () => void;
  onClear:   () => void;
  onEdit:    (key: string, rule: LensRule) => void;
  onConfirm: (entry: RuleEntry) => void;
  onDrop:    (entry: RuleEntry) => void;
  onDiscard: (entry: RuleEntry) => void;
}) => {
  const [offered, setOffered] = useState<LensOption[]>([]);
  const [symbols, setSymbols] = useState<string[]>([]);

  useEffect(() => {
    const asked = new AbortController();

    catalog<{ items: LensOption[] }>(`/lenses/options/${encodeURIComponent(venue)}`, asked.signal)
      .then(({ items }) => setOffered(items)).catch(() => undefined);

    /**
     * **The whole list, once.** A venue has thousands of instruments and the
     * search is three characters deep, so filtering here costs nothing and asking
     * the catalog on every keystroke would cost a request each.
     *
     * From the lens endpoint rather than the contents one, because a lens can be
     * written about every venue at once and `*` is not a venue anything else
     * knows about.
     */
    catalog<{ items: string[] }>(`/lenses/instruments/${encodeURIComponent(venue)}`, asked.signal)
      .then(({ items }) => setSymbols(items)).catch(() => undefined);

    return () => asked.abort();
  }, [venue]);

  return (
    <Card withBorder padding="md" radius="sm">
      <Stack gap="sm">
        <Group justify="space-between" align="baseline">
          <Group gap="xs" align="baseline">
            <Title order={2} size="h6" tt={venue === GLOBAL ? undefined : 'uppercase'}>
              {venue === GLOBAL ? 'All venues' : venue}
            </Title>
            {venue === GLOBAL && (
              <Text size="xs" c="dimmed" fs="italic">
                applied to every venue, together with that venue&rsquo;s own rules
              </Text>
            )}
            <Button
              size="compact-xs" variant="subtle" color="red" opacity={0.55}
              disabled={entries.length === 0 || storing !== null} loading={storing === `clear:${venue}`}
              title={`Store the lens without any of ${venue === GLOBAL ? 'the all-venue' : `${venue}'s`} rules`}
              onClick={onClear}
            >Clear</Button>
          </Group>
          <Button size="compact-xs" variant="subtle" onClick={onAdd}>Add rule</Button>
        </Group>

        {entries.map(entry => (
          <Rule
            key={entry.key} rule={entry.now} offered={offered} symbols={symbols}
            state={stateOf(entry)} busy={storing === entry.key} locked={storing !== null}
            problems={problems[entry.key] ?? []}
            onChanged={to => onEdit(entry.key, to)}
            onConfirm={() => onConfirm(entry)}
            onDrop={() => onDrop(entry)}
            onDiscard={() => onDiscard(entry)}
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
const Rule = ({ rule, offered, symbols, problems, state, busy, locked, onChanged, onConfirm, onDrop, onDiscard }: {
  rule:      LensRule;
  offered:   LensOption[];
  symbols:   string[];
  problems:  LensProblem[];

  /** Never confirmed, edited since it was, or as stored — which decides the buttons it has. */
  state:     'new' | 'changed' | 'saved';

  /** This rule is being stored; `locked`, any rule is. */
  busy:      boolean;
  locked:    boolean;
  onChanged: (rule: LensRule) => void;
  onConfirm: () => void;
  onDrop:    () => void;
  onDiscard: () => void;
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
    <Card withBorder padding="sm" radius="sm" bg="var(--mantine-color-default)"
      style={state === 'saved' ? undefined : { borderColor: 'var(--mantine-color-yellow-6)' }}>
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

        {/*
          A rule is stored on its own: Confirm stores the lens with it, Drop
          without it. A draft can be discarded, or an edit reverted, at no cost.
          The yellow border is what marks a draft; Confirm's title says which kind.
        */}
        <Group justify="flex-end" gap="xs">
          {state === 'saved' && (
            <Button size="compact-xs" variant="subtle" color="red" loading={busy} disabled={locked && ! busy}
              title="Store the lens without this rule" onClick={onDrop}>Drop Rule</Button>
          )}
          {state !== 'saved' && (
            <>
              <Button size="compact-xs" variant="subtle" color="gray" disabled={locked}
                title={state === 'new' ? 'Throw this draft away' : 'Back to the rule as it is stored'}
                onClick={onDiscard}>{state === 'new' ? 'Discard' : 'Revert'}</Button>
              <Button size="compact-xs" color="green" loading={busy} disabled={locked && ! busy}
                title={state === 'new' ? 'Not confirmed yet — store the lens with this rule'
                  : 'Changed since it was confirmed — store the lens with this edit'}
                onClick={onConfirm}>Confirm</Button>
            </>
          )}
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

              // A lens never saved is only the page's: there is nothing to ask the catalog.
              if (lens.id === undefined) { onGone(); return; }

              remove(`/api/catalog/lenses/${encodeURIComponent(lens.slug)}`)
                .then(onGone).catch(err => onFailed((err as Error).message));
            }}>Delete</Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
};

const Naming = ({ opened, taken, onClose, onNamed }: {
  opened:  boolean;
  taken:   string[];
  onClose: () => void;
  onNamed: (lens: Lens) => void;
}) => {
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => { if (opened) { setSlug(''); setName(''); setNote(''); setOwn(false); } }, [opened]);

  /**
   * **The address follows the name until it is touched.** Most lenses want the
   * obvious slug, and typing the same words twice is the kind of friction that
   * makes people accept whatever was offered.
   */
  const [own, setOwn] = useState(false);

  const suggested = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 64);

  const addressed = own ? slug : suggested;
  const clash     = taken.includes(addressed);

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
          error={clash ? 'A lens already has this address' : undefined}
          inputWrapperOrder={['label', 'input', 'description', 'error']}
          onChange={event => {
            setOwn(true);
            setSlug(event.currentTarget.value.trim().toLowerCase());
          }}
        />
        <TextInput label="What it is for" value={note}
          onChange={event => setNote(event.currentTarget.value)} />
        <Text size="xs" c="dimmed">
          Nothing is stored yet: the lens is saved by Save, or by confirming its first rule.
        </Text>
        <Group justify="flex-end">
          <Button size="xs" variant="default" onClick={onClose}>Cancel</Button>
          <Button size="xs" disabled={addressed.length < 2 || clash} onClick={() => onNamed({
            slug: addressed, name: name.trim(), note,
            createdAt: '', updatedAt: '', definition: { format: 1, venues: {} },
          })}>Create</Button>
        </Group>
      </Stack>
    </Modal>
  );
};
