
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
 * Grammar:
 *
 *   item ::= [queue][@[type:]exchange][(modifiers)]
 *          | type:exchange[(modifiers)]          ← shorthand for exchange-only
 *
 *   rule ::= item[&item]* > item[&item]*
 *
 *   rules ::= [|] rule [| rule]*
 *
 *   modifiers ::= modifier[,modifier]*
 *
 * Whitespace around `|`, `>`, `&`, `(`, `)` and `,` is ignored, so rules can span
 * lines; whitespace inside a queue or exchange name is an error. An item has at
 * most one modifier group, and nothing follows it.
 *
 * Multiple sources/destinations joined with `&` are expanded into individual
 * rules (cross-product). Each `|`-separated block is one rule set.
 *
 * Modifier syntax inside parentheses:
 *   key:value            — routing key (bindingKey on source, output key on destination)
 *   key:value:replace    — routing key with a replacement
 *   header:name=value    — a header; the value keeps its inner spaces
 *
 * An item has at most one `key:` modifier, and each header name at most once.
 * The parser accepts every modifier on either side of a rule; which modifiers a
 * side allows is for the caller to enforce.
 */
export const parseRules = (raw: string): ParsedRule[] => {
  const ruleStrings = splitTrimmed(raw, '|');
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

    const sources = splitTrimmed(sides[0]!, '&');
    const dests   = splitTrimmed(sides[1]!, '&');

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

/** Split on `sep`, trim each piece, and drop the empty ones. */
const splitTrimmed = (raw: string, sep: string): string[] =>
  raw.split(sep).map(part => part.trim()).filter(Boolean);

const parseItem = (raw: string): ParsedItem => {
  const parenStart = raw.indexOf('(');
  const parenEnd   = raw.indexOf(')');

  if (parenStart >= 0 && ! raw.endsWith(')'))
    throw new Error(`Unclosed parenthesis in "${raw}"`);

  if (
    parenStart !== raw.lastIndexOf('(') ||
    parenEnd   !== raw.lastIndexOf(')') ||
    (parenEnd >= 0 && parenStart < 0)
  ) {
    throw new Error(`An item takes one modifier group, at its end: "${raw}"`);
  }

  const mainPart   = parenStart >= 0 ? raw.slice(0, parenStart).trimEnd() : raw;
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

  for (const token of splitTrimmed(content, ',')) {
    const keyMatch = KEY_MOD_RE.exec(token);
    if (keyMatch) {
      if (result.routingKey) throw new Error(`More than one key: modifier in "${raw}"`);
      const value   = keyMatch.groups!.value!.trim();
      const replace = keyMatch.groups!.replace?.trim();
      if (! value) throw new Error(`key modifier requires a value: "${token}"`);
      result.routingKey = { value, ...(replace !== undefined ? { replace } : {}) };
      continue;
    }

    const headerMatch = HEADER_MOD_RE.exec(token);
    if (headerMatch) {
      const name = headerMatch.groups!.name!.trim();
      if (! name) throw new Error('header name cannot be empty');
      if (! result.headers) result.headers = {};
      if (Object.prototype.hasOwnProperty.call(result.headers, name)) throw new Error(`Header "${name}" set more than once in "${raw}"`);
      result.headers[name] = headerMatch.groups!.val!.trim();
      continue;
    }

    if (token.startsWith('header:'))
      throw new Error(`header modifier requires "=" separator: "${token}"`);
    else
      throw new Error(`Unknown modifier "${token}" in "${raw}"`);
  }

  return result;
};
