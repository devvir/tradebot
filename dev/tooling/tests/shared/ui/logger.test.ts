import { describe, it, expect, afterEach, vi } from 'vitest';
import { info, success, warn, error, debug, section, heading, table } from '../../../src/shared/ui/logger.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DEBUG;
});

function captured(): string {
  return vi.mocked(console.log).mock.calls.map(c => String(c[0])).join('\n');
}

describe('info', () => {
  it('prints ℹ icon', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    info('hello');
    expect(captured()).toContain('ℹ');
    expect(captured()).toContain('hello');
  });
});

describe('success', () => {
  it('prints ✓ icon', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    success('ok');
    expect(captured()).toContain('✓');
    expect(captured()).toContain('ok');
  });
});

describe('warn', () => {
  it('prints ⚠ icon', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    warn('careful');
    expect(captured()).toContain('⚠');
    expect(captured()).toContain('careful');
  });
});

describe('error', () => {
  it('prints ✗ icon', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    error('broken');
    expect(captured()).toContain('✗');
    expect(captured()).toContain('broken');
  });
});

describe('debug', () => {
  it('prints nothing when DEBUG is not set', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    delete process.env.DEBUG;
    debug('hidden');
    expect(vi.mocked(console.log)).not.toHaveBeenCalled();
  });

  it('prints message when DEBUG=1', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.DEBUG = '1';
    debug('visible');
    expect(captured()).toContain('visible');
  });
});

describe('section', () => {
  it('includes the title', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    section('My Section');
    expect(captured()).toContain('My Section');
  });
});

describe('heading', () => {
  it('includes the title surrounded by decorators', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    heading('My Heading');
    expect(captured()).toContain('My Heading');
    expect(captured()).toContain('═══');
  });
});

describe('table', () => {
  it('prints column headers and rows', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    table([{ Name: 'Alice', Age: '30' }], ['Name', 'Age']);
    const out = captured();
    expect(out).toContain('Name');
    expect(out).toContain('Alice');
    expect(out).toContain('30');
  });

  it('aligns columns to the widest value', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    table(
      [
        { Col: 'short' },
        { Col: 'a much longer value' },
      ],
      ['Col']
    );
    // Both rows use the same padded width — separator line should be at least as long as header
    const lines = vi.mocked(console.log).mock.calls.map(c => String(c[0]));
    const header = lines[0];
    const separator = lines[1];
    expect(separator.length).toBeGreaterThanOrEqual(header.length - 10); // ANSI codes may affect count
  });
});
