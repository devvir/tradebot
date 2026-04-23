"""
Discovery and conversion of vault source files to Parquet.

Source layout:
  /data/bitmex/vault/<stream>/<year>/YYYYMMDD.csv.gz  (one file per day)

Parquet output mirrors the source under <data_dir>/parquet/vault/:
  <data_dir>/parquet/vault/<stream>/<year>/YYYYMMDD.parquet
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import polars as pl


# ── Scope constants ────────────────────────────────────────────────────────────

YEAR_MIN = 2020
YEAR_MAX = 2021

# Streams needed for calibration — others (funding, insurance, etc.) are ignored.
STREAMS = ['orderBookL2', 'quote', 'trade']


# ── Job ───────────────────────────────────────────────────────────────────────

@dataclass
class ConvertJob:
    """One source file → one Parquet file."""
    source: Path
    output: Path
    label: str

    @property
    def is_done(self) -> bool:
        return self.output.exists()

    @property
    def is_stale_tmp(self) -> bool:
        return self.output.with_suffix('.tmp').exists()


def parquet_root(data_dir: str) -> Path:
    return Path(data_dir) / 'parquet'


# ── Discovery ─────────────────────────────────────────────────────────────────

def discover_jobs(
    data_dir: str,
    streams: list[str] | None = None,
) -> list[ConvertJob]:
    """
    Walk vault/<stream>/<year>/YYYYMMDD.csv.gz and return one ConvertJob per file,
    filtered to YEAR_MIN–YEAR_MAX and the given streams (default: STREAMS).
    """
    root = Path(data_dir) / 'vault'

    if not root.exists():
        return []

    active_streams = streams if streams is not None else STREAMS
    proot = parquet_root(data_dir)
    jobs: list[ConvertJob] = []

    for stream_dir in sorted(root.iterdir()):
        if not stream_dir.is_dir():
            continue

        if stream_dir.name not in active_streams:
            continue

        for year_dir in sorted(stream_dir.iterdir()):
            if not year_dir.is_dir():
                continue

            try:
                year = int(year_dir.name)
            except ValueError:
                continue

            if not (YEAR_MIN <= year <= YEAR_MAX):
                continue

            for source in sorted(year_dir.glob('*.csv.gz')):
                rel = source.relative_to(root)
                output = proot / 'vault' / rel.with_suffix('').with_suffix('.parquet')
                label = f'{stream_dir.name}/{year_dir.name}/{source.stem.replace(".csv", "")}'
                jobs.append(ConvertJob(source=source, output=output, label=label))

    return jobs


# ── Conversion ────────────────────────────────────────────────────────────────

def convert_job(job: ConvertJob) -> None:
    """
    Convert one vault CSV.gz to Parquet.
    Atomic: writes to .tmp then renames on success, deletes .tmp on failure.
    """
    tmp = job.output.with_suffix('.tmp')
    job.output.parent.mkdir(parents=True, exist_ok=True)

    try:
        _do_convert(job.source, tmp)
    except BaseException:
        if tmp.exists():
            tmp.unlink()
        raise

    tmp.rename(job.output)


def _do_convert(source: Path, output: Path) -> None:
    """Read one vault CSV.gz with Polars and write Parquet (zstd compressed).

    Normalises BitMEX's non-standard 'D' date/time separator to 'T' in all
    string columns so downstream code gets valid ISO 8601 timestamps.
    """
    df = pl.read_csv(source, infer_schema_length=10_000)

    # Some vault streams (quote, trade) use "2020-01-01D00:00:00" instead of
    # the standard "2020-01-01T00:00:00". Fix in any string column that matches.
    timestamp_cols = [
        col for col, dtype in df.schema.items()
        if dtype == pl.Utf8
    ]

    if timestamp_cols:
        df = df.with_columns([
            pl.col(col).str.replace(r'^(\d{4}-\d{2}-\d{2})D', '${1}T')
            for col in timestamp_cols
        ])

    df.write_parquet(output, compression='zstd')


# ── Utilities ─────────────────────────────────────────────────────────────────

def cleanup_stale_tmp(data_dir: str) -> int:
    """Remove leftover .tmp files from interrupted conversions. Returns count removed."""
    count = 0

    for tmp in parquet_root(data_dir).rglob('*.tmp'):
        tmp.unlink()
        count += 1

    return count


def format_duration(seconds: float) -> str:
    if seconds < 60:
        return f'{seconds:.0f}s'
    elif seconds < 3600:
        return f'{seconds / 60:.0f}m'
    else:
        return f'{seconds / 3600:.1f}h'
