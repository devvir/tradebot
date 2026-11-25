import { describe, it, expect } from 'vitest';
import { terminalSafe } from '../../../src/shared/utils/terminal';

describe('terminalSafe', () => {
  it('leaves printable text, including non-ASCII, as it is', () => {
    expect(terminalSafe('trades.btc-usd · ünïcödé ✓')).toBe('trades.btc-usd · ünïcödé ✓');
  });

  it('escapes ESC, so colour and cursor sequences show as text', () => {
    expect(terminalSafe('\x1b[31mred\x1b[0m')).toBe('\\x1b[31mred\\x1b[0m');
    expect(terminalSafe('\x1b[2J\x1b[H')).toBe('\\x1b[2J\\x1b[H');
  });

  it('escapes OSC sequences that would set the title or plant a link', () => {
    expect(terminalSafe('\x1b]0;pwned\x07')).toBe('\\x1b]0;pwned\\x07');
    expect(terminalSafe('\x1b]8;;http://evil\x1b\\click\x1b]8;;\x1b\\'))
      .toBe('\\x1b]8;;http://evil\\x1b\\click\\x1b]8;;\\x1b\\');
  });

  it('escapes DEL and the single-byte C1 introducers', () => {
    expect(terminalSafe('a\x7fb\x9b31mc\x9d0;t\x9c')).toBe('a\\x7fb\\x9b31mc\\x9d0;t\\x9c');
  });

  it('keeps text on one line by default', () => {
    expect(terminalSafe('a\nb\tc\rd\x00e')).toBe('a\\x0ab\\x09c\\x0dd\\x00e');
  });

  it('with multiline, keeps tabs and line breaks but escapes a bare carriage return', () => {
    expect(terminalSafe('a\nb\tc\r\nd', { multiline: true })).toBe('a\nb\tc\r\nd');
    expect(terminalSafe('shown\rhidden', { multiline: true })).toBe('shown\\x0dhidden');
    expect(terminalSafe('\x1b[31mx\x08', { multiline: true })).toBe('\\x1b[31mx\\x08');
  });
});
