/** Every C0 control, DEL and every C1 control. */
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/g;

/** The same, except tab, line feed and a carriage return that ends a line. */
const CONTROLS_BUT_LINE_BREAKS = /\r(?!\n)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/**
 * Text from outside the tool — a message body, a queue or container name, a broker's error — made
 * safe to print: every control character is written out as a visible `\xNN` escape, so the terminal
 * shows it instead of acting on it. Escaping ESC (and the single-byte C1 introducers) leaves no
 * ANSI, CSI or OSC sequence that can recolour the screen, move the cursor, set the window title or
 * plant a link; the printable rest of such a sequence shows as plain text.
 *
 * With `multiline`, tabs and line breaks (`\n` and `\r\n`) are kept, for text meant to span lines;
 * otherwise they are escaped too, so the text stays on one line.
 */
export function terminalSafe(text: string, options: { multiline?: boolean } = {}): string {
  const pattern = options.multiline ? CONTROLS_BUT_LINE_BREAKS : CONTROLS;

  return text.replace(pattern, ch => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
}
