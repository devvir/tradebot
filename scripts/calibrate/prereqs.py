"""
Prerequisite checking for analysis commands.

Each command declares which vault/tardis streams it needs. This module discovers
the relevant jobs, checks conversion status, and interactively prompts when files
are missing — giving the user the choice to convert, skip, or quit.
"""

from __future__ import annotations

import time

import click

from convert import ConvertJob, convert_job, cleanup_stale_tmp, format_duration


def check_prereqs(
    data_dir: str,
    jobs: list[ConvertJob],
    *,
    allow_skip: bool = True,
) -> list[ConvertJob]:
    """
    Given a list of conversion jobs required by an analysis command, check which
    are already done, prompt if any are missing, and return the available jobs.

    If allow_skip is False, missing files are a hard error (no skip option).
    """
    if not jobs:
        click.echo('No source files found under the data directory. Nothing to do.')
        raise SystemExit(0)

    done = [j for j in jobs if j.is_done]
    missing = [j for j in jobs if not j.is_done]

    if not missing:
        return done

    _print_status(done, missing)

    options = '[c] Convert missing'
    if allow_skip and done:
        options += '  [s] Skip missing, use available'
    options += '  [q] Quit'

    default = 's' if (allow_skip and done) else 'c'
    valid = ['c', 'q'] + (['s'] if allow_skip and done else [])

    click.echo()
    choice = click.prompt(f'  {options}', type=click.Choice(valid, case_sensitive=False), default=default)

    if choice == 'q':
        raise SystemExit(0)

    if choice == 's':
        click.echo(f'  Skipping {len(missing)} missing files, proceeding with {len(done)} available.\n')
        return done

    # Convert
    stale = cleanup_stale_tmp(data_dir)

    if stale:
        click.echo(f'  Cleaned up {stale} stale .tmp file(s) from a previous interrupted run.\n')

    click.echo()
    _convert_with_progress(missing)
    click.echo()

    return jobs


def _print_status(done: list[ConvertJob], missing: list[ConvertJob]) -> None:
    click.echo('\n  Checking required files...\n')

    if done:
        click.echo(f'    ✓  {len(done)} file(s) already converted')

    if missing:
        click.echo(f'    ⚠  {len(missing)} file(s) need conversion')

    if not done:
        click.echo('\n  No converted files available yet.')


def _convert_with_progress(jobs: list[ConvertJob]) -> None:
    total = len(jobs)
    elapsed_times: list[float] = []

    for i, job in enumerate(jobs, 1):
        remaining_str = _remaining_estimate(elapsed_times, total - i)
        suffix = f'  (~{remaining_str} remaining)' if remaining_str else ''
        click.echo(f'  [{i}/{total}]  {job.label}{suffix}  ', nl=False)

        t0 = time.monotonic()

        try:
            convert_job(job)
            elapsed = time.monotonic() - t0
            elapsed_times.append(elapsed)
            click.echo(f'✓  ({elapsed:.1f}s)')
        except NotImplementedError:
            click.echo('✗  (conversion not yet implemented)')
            raise
        except Exception as e:
            click.echo(f'✗  {e}')
            raise


def _remaining_estimate(elapsed: list[float], remaining_count: int) -> str | None:
    if not elapsed or remaining_count <= 0:
        return None

    avg = sum(elapsed) / len(elapsed)
    return format_duration(avg * remaining_count)
