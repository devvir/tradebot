# Archives Module

Brings venue archives to disk: it establishes what each venue publishes — every file, its size and its
checksum — and downloads what a lens selects.

**Discovery is not entangled with downloading.** Prospector surveys and writes the catalog and never
fetches archive data; hauler downloads and never asks a venue what exists. Each carries only its own
per-venue nuance, and the whole picture of a venue (how many files, how large, over which periods)
arrives in hours, before anything is fetched.

## Services

| Service | Role |
|---------|------|
| **prospector** | Surveys venue archives and writes the catalog. Its collector API is private to the module |
| **catalog** | The public API over the catalog: S3-style listings, contents, lenses |
| **hauler** | Walks each venue's listing (only what is still owed, through `HAULER_LENS`) and writes the files |
| **catalog-ui** | How a person reads the catalog, edits lenses, and starts or pauses surveys |

## Usage

```bash
tb up archives          # Start
tb up archives --build  # Rebuild and start
tb down archives        # Stop
tb logs archives        # Stream progress
tb ps archives          # Check status
```

Prospector surveys nothing on its own. Starting the module neither triggers a survey nor loses one: an
interrupted job keeps its cursors and resumes when it is next asked to. Surveys are started and paused
from catalog-ui (`CATALOG_UI_PORT`); prospector publishes no API port.

Consumers outside the module reach the catalog at `CATALOG_PORT` — see
[CATALOG-API.md](../../../docs/modules/CATALOG-API.md).

## Configuration

Copy `.env.example` to `.env` and update as needed.

`CATALOG_DIR` is the host directory holding `catalog.db`, mounted at a fixed `/data/catalog` in both
prospector and catalog, which must therefore run on the same host. Pre-create it owned by uid 1000:

```bash
sudo mkdir -p /storage/tradebot/catalog && sudo chown 1000:1000 /storage/tradebot/catalog
```

See [ARCHIVES.md](../../../docs/modules/ARCHIVES.md) for how the pieces fit, and each service's doc
under `docs/services/` for its variables.
