
// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParsedExchange {
  name: string;
  type?: 'fanout' | 'topic' | 'direct' | 'headers' | 'default';
}

export interface ParsedItem {
  queue?:      string;
  exchange?:   ParsedExchange;
  routingKey?: { value: string; replace?: string };
  headers?:    Record<string, string>;
}

export interface ParsedRule {
  source:      ParsedItem;
  destination: ParsedItem;
}

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * Parse a connector rule string into a flat array of source→destination pairs.
 *
 * Grammar (whitespace is stripped before parsing):
 *
 *   item ::= [queue][@[type:]exchange][(modifiers)]
 *          | type:exchange[(modifiers)]          ← shorthand for exchange-only
 *
 *   rule ::= item[&item]* > item[&item]*
 *
 *   rules ::= [|] rule [| rule]*
 *
 * Multiple sources/destinations joined with `&` are expanded into individual
 * rules (cross-product). Each `|`-separated block is one rule set.
 *
 * Modifier syntax inside parentheses:
 *   key:value            — routing key (bindingKey on source, output key on destination)
 *   key:value:replace    — routing key with replacement (destination only)
 *   header:name=value    — header injection (destination only)
 */
export const parseRules = (raw: string): ParsedRule[] => {
  const ruleStrings = raw.replace(/\s/g, '').split('|').filter(Boolean);
  const rules: ParsedRule[] = [];

  for (const rule of ruleStrings) {
    const sides = rule.split('>');

    if (sides.length !== 2) {
      throw new Error(
        sides.length < 2
          ? `Rule missing '>': "${rule}"`
          : `Rule must have exactly one '>': "${rule}"`,
      );
    }

    const sources = sides[0]!.split('&').filter(Boolean);
    const dests   = sides[1]!.split('&').filter(Boolean);

    if (! sources.length) throw new Error(`No sources in rule: "${rule}"`);
    if (! dests.length)   throw new Error(`No destinations in rule: "${rule}"`);

    for (const src of sources) {
      for (const dest of dests) {
        rules.push({ source: parseItem(src), destination: parseItem(dest) });
      }
    }
  }

  return rules;
};

// ── Internal ──────────────────────────────────────────────────────────────────

const VALID_TYPES    = new Set(['fanout', 'topic', 'direct', 'headers', 'default']);
const KEY_MOD_RE     = /^key:(?<value>[^:]+)(?::(?<replace>.*))?$/;
const HEADER_MOD_RE  = /^header:(?<name>[^=]*)=(?<val>.*)$/;

const parseItem = (raw: string): ParsedItem => {
  const parenStart = raw.indexOf('(');

  if (raw.includes('(') && ! raw.endsWith(')'))
    throw new Error(`Unclosed parenthesis in "${raw}"`);

  const mainPart   = parenStart >= 0 ? raw.slice(0, parenStart) : raw;
  const modContent = parenStart >= 0 ? raw.slice(parenStart + 1, -1) : undefined;

  let queue:    string          | undefined;
  let exchange: ParsedExchange  | undefined;

  const atIdx = mainPart.indexOf('@');

  if (atIdx >= 0) {
    // Explicit exchange: [queue]@[type:]name
    const queuePart    = mainPart.slice(0, atIdx);
    const exchangePart = mainPart.slice(atIdx + 1);

    if (queuePart && ! /^[\w.-]+$/.test(queuePart))
      throw new Error(`Invalid queue name "${queuePart}" in "${raw}"`);

    queue    = queuePart || undefined;
    exchange = parseExchangePart(exchangePart, raw);
  } else {
    const colonIdx = mainPart.indexOf(':');

    if (colonIdx >= 0) {
      // type:name shorthand — colon without @ is only valid when prefix is a known type
      const typePart = mainPart.slice(0, colonIdx);
      const namePart = mainPart.slice(colonIdx + 1);

      if (! VALID_TYPES.has(typePart)) {
        throw new Error(
          `Invalid exchange type "${typePart}" in "${raw}". ` +
          `Valid types: ${[...VALID_TYPES].join(', ')}`,
        );
      }

      if (! /^[\w.-]+$/.test(namePart))
        throw new Error(`Invalid exchange name "${namePart}" in "${raw}"`);

      exchange = { name: namePart, type: typePart as ParsedExchange['type'] };
    } else {
      // Bare name → queue
      if (mainPart && ! /^[\w.-]+$/.test(mainPart))
        throw new Error(`Invalid route item: "${raw}"`);

      queue = mainPart || undefined;
    }
  }

  if (! queue && ! exchange) throw new Error(`Invalid route item: "${raw}"`);

  return {
    ...(queue    ? { queue }    : {}),
    ...(exchange ? { exchange } : {}),
    ...parseModifiers(modContent, raw),
  };
};

const parseExchangePart = (raw: string, context: string): ParsedExchange => {
  const colonIdx = raw.indexOf(':');

  if (colonIdx >= 0) {
    const type = raw.slice(0, colonIdx);
    const name = raw.slice(colonIdx + 1);

    if (! VALID_TYPES.has(type)) {
      throw new Error(
        `Invalid exchange type "${type}" in "${context}". ` +
        `Valid types: ${[...VALID_TYPES].join(', ')}`,
      );
    }

    if (! /^[\w.-]+$/.test(name))
      throw new Error(`Invalid exchange name "${name}" in "${context}"`);

    return { name, type: type as ParsedExchange['type'] };
  }

  if (! /^[\w.-]+$/.test(raw))
    throw new Error(`Invalid exchange name "${raw}" in "${context}"`);

  return { name: raw };
};

const parseModifiers = (
  content: string | undefined,
  raw: string,
): Pick<ParsedItem, 'routingKey' | 'headers'> => {
  if (! content) return {};

  const result: Pick<ParsedItem, 'routingKey' | 'headers'> = {};

  for (const token of content.split(',').filter(Boolean)) {
    const keyMatch = KEY_MOD_RE.exec(token);
    if (keyMatch) {
      const { value, replace } = keyMatch.groups!;
      result.routingKey = { value: value!, ...(replace !== undefined ? { replace } : {}) };
      continue;
    }

    const headerMatch = HEADER_MOD_RE.exec(token);
    if (headerMatch) {
      const { name, val } = headerMatch.groups!;
      if (! name) throw new Error('header name cannot be empty');
      if (! result.headers) result.headers = {};
      result.headers[name] = val!;
      continue;
    }

    if (token.startsWith('header:'))
      throw new Error(`header modifier requires "=" separator: "${token}"`);
    else
      throw new Error(`Unknown modifier "${token}" in "${raw}"`);
  }

  return result;
};
