import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── mocks ─────────────────────────────────────────────────────────────────────

vi.mock('axios', () => ({
  default: { get: vi.fn() },
}));

vi.mock('../../src/shared/connections/bouncer', () => ({
  discoverBouncerUrl: vi.fn().mockResolvedValue('http://localhost:3010'),
}));

import axios from 'axios';
import { discoverBouncerUrl } from '../../src/shared/connections/bouncer';
import { run } from '../../src/tools/bouncer/index';

const ACCOUNTS = [
  { name: 'MainBot', exchange: 'bitmex', testnet: false, key: 'abc123xyz789', token: 'secret' },
  { name: 'TestBot', exchange: 'bitmex', testnet: true, key: 'def456uvw012', token: 'other' },
];

describe('bouncer tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when bouncer URL is not available', async () => {
    vi.mocked(discoverBouncerUrl).mockResolvedValueOnce(null);
    await expect(run()).rejects.toThrow('BOUNCER_URL not configured');
  });

  it('fetches accounts from discovered bouncer URL', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: ACCOUNTS });
    await run({});
    expect(axios.get).toHaveBeenCalledWith('http://localhost:3010/accounts', expect.any(Object));
  });

  it('renders a summary table by default (all account names appear in output)', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: ACCOUNTS });
    await run({});
    const output = vi.mocked(console.log).mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('MainBot');
    expect(output).toContain('TestBot');
  });

  it('shows key prefix and masked token when --all is set', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: ACCOUNTS });
    await run({ all: true });
    const output = vi.mocked(console.log).mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('abc123xy');
    expect(output).toContain('••••••••');
  });

  it('shows JSON for a specific account when --account is set', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: ACCOUNTS });
    await run({ account: 'MainBot' });
    const output = vi.mocked(console.log).mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('"name": "MainBot"');
  });

  it('warns when --account name is not found', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: ACCOUNTS });
    vi.mocked(console.log).mockRestore();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run({ account: 'Nonexistent' });
    const output = spy.mock.calls.map(c => String(c[0])).join('\n');
    expect(output).toContain('Nonexistent');
  });

  it('exits early when no accounts are returned', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: [] });
    await expect(run({})).resolves.toBeUndefined();
  });

  it('throws on network error', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(run()).rejects.toThrow('ECONNREFUSED');
  });
});
