# @tradebot/utils

Small helpers shared by the services of this repo.

| Module | Exports |
|---|---|
| `csv` | `rowToCsv` writes one CSV line, quoting a field only when it holds `,`, `"`, `\n` or `\r`; `createCsvParser` is a `csv-parse` stream that reads what `rowToCsv` writes |
| `routes` | `parseRules`, the parser of the [rule grammar](#rule-grammar) |
| `security` | `redactUrl` masks the credentials of a URL for logging; `sanitizeUrl` percent-encodes them |
| `services` | `SKFactory`, a service-kit factory with RabbitMQ (`QUEUE_URL`) and Redis (`CACHE_URL`, `CACHE_PASS`) providers, a health check on port 3000, and optional message tracking |
| `sizes` | `sizeOf` writes a byte count as `912 B`, `18.1 MB`, `2.4 GB` |
| `tables` | `TABLE_SPECS` and the BitMEX table sets `WS_TABLES` and `FREE_TEXT_TABLES`, with `baseTable` |

The `@tradebot/utils/testing` subpath holds test helpers: `.env` parsing (`parseEnvFile`,
`loadTestingEnv`) and a throwaway RabbitMQ under docker compose (`startRabbitMQ`, `stopRabbitMQ`).

## Rule grammar

`parseRules(raw)` reads a string of rules, each connecting sources to destinations, and returns a
flat list of `{ source, destination }` pairs. Each side is an item with an optional `queue`, an
optional `exchange` (`{ name, type? }`), an optional `routingKey` (`{ value, replace? }`) and
optional `headers`. The parser checks syntax only; what an item means, and which items and
modifiers a side allows, is for the caller to decide.

```
rules     ::= [|] rule [| rule]*
rule      ::= item [& item]* > item [& item]*
item      ::= [queue]@[type:]exchange[(modifiers)]
            | type:exchange[(modifiers)]
            | queue[(modifiers)]
modifiers ::= modifier [, modifier]*
modifier  ::= key:value | key:value:replace | header:name=value
```

### Items

| Written | Queue | Exchange |
|---|---|---|
| `q` | `q` | none |
| `q@x` | `q` | `x`, no type |
| `q@topic:x` | `q` | `x`, `topic` |
| `@x` | none | `x`, no type |
| `@topic:x` or `topic:x` | none | `x`, `topic` |

- **Types** are `fanout`, `topic`, `direct`, `headers` and `default`. A `type:` prefix, with or
  without `@`, must be one of them. An exchange written without a type comes back without one;
  the parser assigns no default.
- **Names** of queues and exchanges are one or more ASCII letters, digits, `_`, `.` or `-`.

### Combining items and rules

- `&` joins several sources or several destinations, and a rule expands to their cross product:
  `a & b > c & d` gives `a > c`, `a > d`, `b > c` and `b > d`.
- `|` separates rules. Empty rules, and so a leading `|`, are ignored, which lets a list be
  written one rule per line.
- Each rule has exactly one `>`.
- Whitespace around `|`, `>`, `&`, `(`, `)` and `,` is ignored, so rules can span lines.
  Whitespace inside a queue or exchange name is an error.
- An empty string gives no rules, not an error.

### Modifiers

An item takes at most one modifier group, in parentheses at its end.

| Modifier | Result |
|---|---|
| `key:value` | `routingKey: { value }`; `value` is not empty and holds no `:` |
| `key:value:replace` | `routingKey: { value, replace }`; `replace` may be empty and may hold `:` |
| `header:name=value` | `headers[name] = value`; `name` is not empty, `value` may be; inner spaces of the value are kept |

Values and names are trimmed. An item has at most one `key:` modifier and sets each header name
at most once. Every modifier is accepted on either side of a rule.

### Parse errors

`parseRules` throws on the first problem it finds:

- a rule without `>`, or with more than one
- a rule with no sources or no destinations
- an item that is only a modifier group, or a bare name with a character outside the name set
- an invalid queue or exchange name, including an empty one (`q@`, `@topic:`)
- a `type:` prefix that is not one of the five types
- an unclosed parenthesis, a second modifier group, or anything after the group
- more than one `key:` modifier, or a `key:` with no value
- a `header:` without `=`, with an empty name, or naming a header twice
- any other modifier

## Development

```bash
pnpm build   # Compile TypeScript
pnpm test    # Run tests
```
