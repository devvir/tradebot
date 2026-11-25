/**
 * Whether `tools` opens its interactive menu, and which arguments carry over to
 * the command picked from it.
 *
 * The menu opens only when a person is there to answer it (stdin is a TTY) and
 * every argument is a global option that takes a value: `-e`/`--env` and
 * `-m`/`--module`, in any of the forms commander reads (`-e x`, `-ex`,
 * `--env x`, `--env=x`). Anything else — a command, `--help`, `--version`, an
 * unknown word or flag, an option missing its value — goes to commander, which
 * runs it or says what is wrong with it.
 *
 * Returns the arguments to put in front of the chosen command, or null when
 * the menu does not open.
 */
export function menuArgs(args: readonly string[], isTTY: boolean): string[] | null {
  if (! isTTY) return null;

  const kept: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined) return null;

      kept.push(arg, value);
      i++;
    } else if (/^--(env|module)=/.test(arg) || /^-[em]./.test(arg)) {
      kept.push(arg);
    } else {
      return null;
    }
  }

  return kept;
}

const VALUE_FLAGS = new Set(['-e', '--env', '-m', '--module']);
