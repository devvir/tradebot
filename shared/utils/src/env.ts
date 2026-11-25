// Served by the root entry, and as `@tradebot/utils/env`, which loads this module alone.

import { readFileSync } from 'node:fs';

/** The assignments of one .env file, as written. */
export interface EnvFile {
  /** Each key's value, `${VAR}` references left as written. A key set twice has its last value. */
  values: Record<string, string>;
  /** The keys whose value is single-quoted, which interpolation leaves as written. */
  literal: Set<string>;
}

/** Where `${VAR}` references look a name up first: a variable environment such as `process.env`. */
export type EnvLookup = Record<string, string | undefined>;

/**
 * The assignments in the text of a .env file, by docker compose's grammar for `KEY=value` lines.
 *
 * - A line is `KEY=value`, optionally prefixed with `export`. A key starts with a letter or `_`,
 *   followed by letters, digits, `_`, `.` or `-`; whitespace around it is ignored. Blank lines,
 *   lines whose first non-blank character is `#`, and lines of any other form are skipped. Lines
 *   end at `\n` or `\r\n`.
 * - A value in single quotes is taken as written. One in double quotes has `\n`, `\"` and `\\`
 *   unescaped; any other backslash is kept as written, `\t` included. Either may hold `#`, and may
 *   be followed by a `#` comment, with or without whitespace before it.
 * - An unquoted value ends at its first ` #` (a value character, a space, then `#`), and is
 *   trimmed. Any other `#` is part of the value: one after a tab, one with no space before it, and
 *   one with nothing before it, so `KEY=   # note` sets KEY to `# note`.
 * - A quote that does not close the value, or is followed by more than a comment, is read as part
 *   of an unquoted value.
 *
 * `${VAR}` references are left as written; `parseEnvFile` expands them.
 */
export const parseEnv = (text: string): EnvFile => {
  const file: EnvFile = { values: {}, literal: new Set() };

  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:#|$)/.test(line)) continue;

    const match = ASSIGNMENT.exec(line);

    if (! match) continue;

    const [, key, raw] = match;
    const { value, quoted } = parseValue(raw);

    file.values[key] = value;

    if (quoted === "'") file.literal.add(key);
    else file.literal.delete(key);
  }

  return file;
};

/**
 * The variables a .env file sets, read by the grammar `parseEnv` describes, with `${VAR}`
 * references expanded as docker compose expands them in a .env file: a reference in an unquoted
 * or double-quoted value takes the variable's value in `lookup` (`process.env` by default), else
 * that of a key set on an earlier line of the file, else the empty string. Single-quoted values
 * are taken as written. Only the `${VAR}` form is expanded; `$VAR` and `${VAR:-default}` are
 * left as written.
 *
 * Throws when the file cannot be read, a missing file included.
 */
export const parseEnvFile = (filePath: string, lookup: EnvLookup = process.env): Record<string, string> => {
  const { values, literal } = parseEnv(readFileSync(filePath, 'utf8'));
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(values)) {
    result[key] = literal.has(key)
      ? value
      : value.replace(REFERENCE, (_, name: string) => lookup[name] ?? (Object.hasOwn(result, name) ? result[name] : ''));
  }

  return result;
};

// ── Internals ─────────────────────────────────────────────────────────────────

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Nothing, or a comment, after a closing quote. */
const AFTER_QUOTE = /^\s*(?:#.*)?$/;

const ESCAPES: Record<string, string> = { n: '\n', '"': '"', '\\': '\\' };

/** One value as written after `=`, and the quote it was written in, by the rules `parseEnv` gives. */
const parseValue = (raw: string): { value: string; quoted: "'" | '"' | null } => {
  const text  = raw.trimStart();
  const quote = text[0];

  if (quote === "'") {
    const end = text.indexOf("'", 1);

    if (end !== -1 && AFTER_QUOTE.test(text.slice(end + 1))) {
      return { value: text.slice(1, end), quoted: "'" };
    }
  } else if (quote === '"') {
    let value = '';

    for (let i = 1; i < text.length; i++) {
      const ch = text[i];

      if (ch === '\\' && i + 1 < text.length) {
        const next = text[i + 1];
        value += ESCAPES[next] ?? ch + next;
        i++;
      } else if (ch === '"') {
        if (AFTER_QUOTE.test(text.slice(i + 1))) return { value, quoted: '"' };
        break;
      } else {
        value += ch;
      }
    }
  }

  // Unquoted, or a quote that does not close the value.
  const comment = text.indexOf(' #');

  return { value: (comment === -1 ? text : text.slice(0, comment)).trimEnd(), quoted: null };
};
