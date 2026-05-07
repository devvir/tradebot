# sources prepare — performance history

Benchmarks run on a single machine. Wall-clock time over all source files for the given dataset.

---

## instrument/2019 sample — 9 files, 80.3 MB, avg 8.9 MB/file

| Run       | Total | vs prev | s/MB  | Change |
|-----------|-------|---------|-------|--------|
| R1        | 1650s |      —  | 20.6  | baseline |
| R2        | 1454s |   -12%  | 18.1  | SHA-256 → string concat in contiguous dedup |
| R3        |  904s |   -38%  | 11.3  | removed POJOs (recordFromArray) |
| R4        |  439s |   -51%  |  5.5  | simplified parsing (readline for large tables) |
| R5        |  336s |   -23%  |  4.2  | rows: string[] (no per-row split, dumb writer) |
| R7        |  174s |   -48%  |  2.2  | lazy sorting |
| R8        |  195s |   +12%  |  2.4  | deduper rewrite (correctness) |
| R9        |  200s |    +3%  |  2.5  | zipper (pigz) |
| R11 (C4)  |   89s |   -55%  |  1.11 | subprocess orchestrator |
| R11 (C6)  |   78s |   -12%  |  0.97 | |
| R11 (C8)  |   76s |    -3%  |  0.95 | |

R6 was never captured; R7 vs prev skips it. R8 is a correctness fix (deduper rewrite) with a small regression; R9 is flat — pigz provides no benefit at this file size. R11 diminishes past C6 — with only 9 files, extra slots sit idle waiting for the straggler.

---

## instrument/full — 144 dates, 173 source files, 13,450 MB, avg 93 MB/date

R11 (C6) figures are pending a re-run of the merged-day dates after fixing the orchestrator bug (single-source-per-date dispatch).

| Run      | Total | vs prev | s/MB |
|----------|-------|---------|------|
| R7       | 5:31h |      —  | 1.48 |
| R8       | 6:25h |   +16%  | 1.72 |
| R9       | 6:07h |    -4%  | 1.64 |
| R11 (C6) | 2:33h |   -48%  | 0.86 |

---

## orderBookL2/2019 sample — 9 files, 2062.6 MB, avg 229 MB/file

| Run      | Total | vs prev | s/MB |
|----------|-------|---------|------|
| R7       | 4628s |      —  | 2.24 |
| R8       | 4620s |     ~0% | 2.24 |
| R9       | 4196s |    -9%  | 2.03 |
| R11 (C5) | 1490s |   -64%  | 0.72 |

R8 re-run after a bug fix; original was 4691s / 2.27 s/MB. R11 uses a subprocess pool — each worker has its own event loop and pigz instance, giving true OS-level parallelism vs the cooperative Promise queue used previously.
