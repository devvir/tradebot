# Services kept for what they know

Not in the workspace: nothing here is installed, built, tested or run. Each collected or stored
BitMEX's data, and BitMEX is gone; each is kept because what comes next will want to read it first.
A service's documentation sits beside it.

| | what it was | kept for |
|---|---|---|
| `scribe/` | the collector of BitMEX's REST history ([SCRIBE.md](scribe/SCRIBE.md)) | how a REST history is walked and kept to a limit: one description per dataset over a generic runner, a budget read from the answers and paced against, pages fetched ahead and written in order, resuming from what is already stored. `docs/planning/REST.md` is the survey of the venues a collector like it would serve |
| `tardy/` | the downloader of Tardis's free monthly samples of BitMEX's websocket tables ([TARDY.md](tardy/TARDY.md)) | **Tardis serves more than BitMEX.** The same free sample — the first day of each month, as the raw websocket messages, order books among them, with no key — is there for each of the seven venues collected here. A downloader for them starts from this one: a day walked a minute at a time, resumed from what is stored, retried. Its address, its tables and where it writes are BitMEX's |
| `vault/` | the store the BitMEX collectors wrote to: date-partitioned CSV files behind an HTTP API ([VAULT.md](vault/VAULT.md)) | how rows arriving over HTTP become a file that is safe on disk at every moment: each write one gzip member appended to an open file, a failed append truncated back and retried, a file sealed once and never written again, writes refused while the disk is unhealthy |

**They do not run as they are.** Their compose files and imports are written for
`services/<name>/`, one level up from where they are now, and scribe and tardy write to vault's
HTTP API. `tsconfig.json` in each still extends the root one, so an editor reads them correctly.
