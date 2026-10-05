import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthShell } from '../components/auth-shell';
import * as api from '../lib/api';
import * as local from '../lib/db';

vi.mock('../components/pos-app', () => ({ PosApp: () => <div>Cached store is available</div> }));
vi.mock('../components/superadmin-console', () => ({ SuperadminConsole: () => <div>Administrator</div> }));
vi.mock('../lib/db', () => ({
  getActiveStoreId: vi.fn(), getSession: vi.fn(), hasCompletedBootstrap: vi.fn(), signOutLocally: vi.fn(),
}));
vi.mock('../lib/api', () => ({
  ApiRequestError: class extends Error {}, fetchSetupStatus: vi.fn(), isInvalidSessionError: () => false,
  loginCashier: vi.fn(), loginOwner: vi.fn(), logout: vi.fn(), rehydrateSession: vi.fn(), setupOwner: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  vi.mocked(local.getSession).mockResolvedValue(undefined);
  vi.mocked(local.getActiveStoreId).mockResolvedValue(undefined);
  vi.mocked(local.hasCompletedBootstrap).mockResolvedValue(false);
});
afterEach(() => cleanup());

it('shows connection feedback, offers retry, and then opens login without mutating local data', async () => {
  vi.mocked(api.fetchSetupStatus).mockRejectedValueOnce(new Error('Server unavailable'))
    .mockResolvedValueOnce({ needsSetup: false });
  render(<AuthShell />);
  expect(screen.getByRole('status').textContent).toContain('Connecting to the demo server');
  fireEvent.click(await screen.findByRole('button', { name: 'Retry connection' }));
  expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
  expect(api.fetchSetupStatus).toHaveBeenCalledTimes(2);
  expect(local.signOutLocally).not.toHaveBeenCalled();
  expect(api.loginOwner).not.toHaveBeenCalled();
});

it('opens the cached store offline without contacting the host or clearing pending sales', async () => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  vi.mocked(local.getSession).mockResolvedValue({ user: { role: 'owner' }, store: { id: 'demo' } } as Awaited<ReturnType<typeof local.getSession>>);
  vi.mocked(local.hasCompletedBootstrap).mockResolvedValue(true);
  vi.mocked(local.getActiveStoreId).mockResolvedValue('demo');
  render(<AuthShell />);
  await waitFor(() => expect(screen.getByText('Cached store is available')).toBeTruthy());
  expect(api.fetchSetupStatus).not.toHaveBeenCalled();
  expect(api.rehydrateSession).not.toHaveBeenCalled();
  expect(local.signOutLocally).not.toHaveBeenCalled();
});
