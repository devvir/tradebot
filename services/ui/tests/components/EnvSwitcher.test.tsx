import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnvSwitcher } from '../../src/components/EnvSwitcher';
import { EnvProvider, useEnv } from '../../src/data/EnvProvider';

const STORAGE_KEY = 'tradebot.ui.env';

beforeEach(() => {
  localStorage.clear();
  globalThis.__REPLAY_ENABLED__ = true;
});

/** Read the env from the provider in tests that need to assert the switch. */
function CurrentEnv() {
  const { env } = useEnv();

  return <span data-testid="current">{env}</span>;
}

function mount() {
  return render(
    <EnvProvider>
      <EnvSwitcher />
      <CurrentEnv />
    </EnvProvider>,
  );
}

// ── Rendering ─────────────────────────────────────────────────────────────────

describe('EnvSwitcher rendering', () => {
  it('renders the three options', () => {
    mount();

    const select = screen.getByRole('combobox', { name: /data environment/i });

    expect(select).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Live' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Testnet' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Replay' })).toBeInTheDocument();
  });

  it('reflects the current env from EnvProvider', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify('testnet'));

    mount();

    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: /data environment/i });

    expect(select.value).toBe('testnet');
  });
});

// ── Replay gating ─────────────────────────────────────────────────────────────

describe('EnvSwitcher replay gating', () => {
  it('disables the Replay option when __REPLAY_ENABLED__ is false', () => {
    globalThis.__REPLAY_ENABLED__ = false;

    mount();

    const replay = screen.getByRole<HTMLOptionElement>('option', { name: 'Replay' });

    expect(replay).toBeDisabled();
  });

  it('enables the Replay option when __REPLAY_ENABLED__ is true', () => {
    globalThis.__REPLAY_ENABLED__ = true;

    mount();

    const replay = screen.getByRole<HTMLOptionElement>('option', { name: 'Replay' });

    expect(replay).not.toBeDisabled();
  });
});

// ── Switching ─────────────────────────────────────────────────────────────────

describe('EnvSwitcher switching', () => {
  it('changing the dropdown calls setEnv and persists the choice', async () => {
    const user = userEvent.setup();

    mount();

    await user.selectOptions(screen.getByRole('combobox', { name: /data environment/i }), 'testnet');

    expect(screen.getByTestId('current')).toHaveTextContent('testnet');
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify('testnet'));
  });
});
