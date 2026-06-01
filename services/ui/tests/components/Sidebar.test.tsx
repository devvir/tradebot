import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sidebar } from '../../src/components/Sidebar';

describe('Sidebar — order type tabs', () => {
  it('starts with Limit as the active tab', () => {
    render(<Sidebar />);

    const limit = screen.getByText('Limit');

    expect(limit.className).toMatch(/sidebar__tab--active/);
  });

  it('clicking Market activates that tab and deactivates Limit', async () => {
    const user = userEvent.setup();

    render(<Sidebar />);

    await user.click(screen.getByText('Market'));

    const market = screen.getByText('Market');
    const limit  = screen.getByText('Limit');

    expect(market.className).toMatch(/sidebar__tab--active/);
    expect(limit.className).not.toMatch(/sidebar__tab--active/);
  });

  it('clicking Stop Market activates that tab', async () => {
    const user = userEvent.setup();

    render(<Sidebar />);

    await user.click(screen.getByText('Stop Market'));

    expect(screen.getByText('Stop Market').className).toMatch(/sidebar__tab--active/);
  });
});
