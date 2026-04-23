#!/usr/bin/env python3
import os
import sys
import time

import click

from convert import (
    YEAR_MIN, YEAR_MAX, STREAMS,
    discover_jobs, convert_job, cleanup_stale_tmp, format_duration,
)
from prereqs import check_prereqs

DEFAULT_DATA_DIR = os.environ.get('DATA_DIR', '/data/bitmex')


@click.group()
@click.option('--data-dir', default=DEFAULT_DATA_DIR, envvar='DATA_DIR', show_default=True,
              help='Vault data root directory.')
@click.pass_context
def cli(ctx: click.Context, data_dir: str) -> None:
    """Synthetic orderbook calibration tools."""
    ctx.ensure_object(dict)
    ctx.obj['data_dir'] = data_dir


# ── convert ───────────────────────────────────────────────────────────────────

@cli.command()
@click.option('--stream', multiple=True, metavar='STREAM',
              help=f'Streams to convert (default: {", ".join(STREAMS)}). Repeatable.')
@click.pass_context
def convert(ctx: click.Context, stream: tuple[str, ...]) -> None:
    """Convert vault source files to Parquet (resumable, {YEAR_MIN}–{YEAR_MAX})."""
    data_dir = ctx.obj['data_dir']
    streams = list(stream) or None

    jobs = discover_jobs(data_dir, streams=streams)

    if not jobs:
        click.echo('No source files found.')
        return

    done = [j for j in jobs if j.is_done]
    missing = [j for j in jobs if not j.is_done]

    click.echo(f'\n  {len(jobs)} files  ·  {len(done)} done  ·  {len(missing)} pending\n')

    if not missing:
        click.echo('  All files already converted.')
        return

    stale = cleanup_stale_tmp(data_dir)

    if stale:
        click.echo(f'  Cleaned up {stale} stale .tmp file(s) from a previous interrupted run.\n')

    total = len(missing)
    elapsed_times: list[float] = []

    for i, job in enumerate(missing, 1):
        eta = _eta(elapsed_times, total - i)
        suffix = f'  (eta {eta})' if eta else ''
        click.echo(f'  [{i}/{total}]  {job.label}{suffix}  ', nl=False)

        t0 = time.monotonic()

        try:
            convert_job(job)
            elapsed = time.monotonic() - t0
            elapsed_times.append(elapsed)
            click.echo(f'✓  ({elapsed:.1f}s)')
        except Exception as e:
            click.echo(f'✗  {e}')
            raise SystemExit(1)

    click.echo(f'\n  Done — converted {total} file(s).\n')


# ── lifecycle ─────────────────────────────────────────────────────────────────

@cli.command()
@click.option('--symbol', required=True, help='Symbol to analyse (e.g. XBTUSD).')
@click.pass_context
def lifecycle(ctx: click.Context, symbol: str) -> None:
    """
    Build order lifecycle table for a symbol.
    Requires converted Parquet files for orderBookL2 and quote.

    Output columns:
      order_id | insert_time | delete_time | lifetime_s |
      insert_size | distance_from_mid_pct | outcome (fill/cancel) | vol_at_insert
    """
    data_dir = ctx.obj['data_dir']

    jobs = discover_jobs(data_dir, streams=['orderBookL2', 'quote'])
    available = check_prereqs(data_dir, jobs)

    click.echo(f'Working with {len(available)} converted file(s) for symbol {symbol}.')
    click.echo('(lifecycle analysis not yet implemented)')


# ── helpers ───────────────────────────────────────────────────────────────────

def _eta(elapsed: list[float], remaining: int) -> str | None:
    if not elapsed or remaining <= 0:
        return None

    avg = sum(elapsed) / len(elapsed)

    return format_duration(avg * remaining)


if __name__ == '__main__':
    cli()
