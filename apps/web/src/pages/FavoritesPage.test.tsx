import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getFavorites: vi.fn(),
  getFavoriteKeys: vi.fn(),
  addFavorite: vi.fn(),
  removeFavorite: vi.fn(),
}));

vi.mock('@web/services/http', () => ({ api: mocks }));

import { renderScreen } from '@web/test/renderScreen';
import { FavoritesPage } from './FavoritesPage';
import type { FavoriteFolder } from '@web/types/favorites';

const netflix: FavoriteFolder = {
  id: 'fav-1',
  facetKey: 'entity=netflix|intent=payment-failed',
  order: ['entity', 'intent'],
  name: 'Payment failed',
  path: 'Netflix/Payment failed',
  fullPath: 'MailMind/Netflix/Payment failed',
  messageCount: 12,
  unreadCount: 2,
  latestReceivedAt: '2026-10-18T09:00:00.000Z',
  iconDomain: 'netflix.com',
  createdAt: '2026-10-18T10:00:00.000Z',
};

function WhereAmI() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderPage() {
  return renderScreen(
    <Routes>
      <Route path="/favorites" element={<FavoritesPage />} />
      <Route path="/inbox" element={<WhereAmI />} />
    </Routes>,
    '/favorites',
  );
}

describe('FavoritesPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getFavorites.mockResolvedValue([netflix]);
    mocks.getFavoriteKeys.mockResolvedValue([netflix.facetKey]);
  });

  it('lists starred folders with their counts, logo and a filled star', async () => {
    const { container } = renderPage();

    expect(await screen.findByText('Payment failed')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('2 new')).toBeInTheDocument();
    expect(container.querySelector('img')?.getAttribute('src')).toMatch(
      /\/facets\/icons\/netflix\.com$/,
    );
    expect(
      await screen.findByRole('button', { name: 'Remove Payment failed from favourites' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  // Over all mail and in its own arrangement, so a favourite always lands on the folder it names.
  it('opens a favourite in the arrangement it was starred from, over all mail', async () => {
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: /^(?!.*favourites).*Payment failed/ }),
    );

    const location = await screen.findByTestId('location');
    const url = new URL(location.textContent!, 'https://app.example');
    expect(url.pathname).toBe('/inbox');
    expect(url.searchParams.get('order')).toBe('entity,intent');
    expect(url.searchParams.get('folder')).toBe(netflix.facetKey);
    expect(url.searchParams.get('range')).toBe('all');
  });

  it('unstars from the favourites screen too', async () => {
    mocks.removeFavorite.mockResolvedValue(undefined);
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Remove Payment failed from favourites' }),
    );

    await waitFor(() => expect(mocks.removeFavorite).toHaveBeenCalledWith(netflix.facetKey));
  });

  it('says how to add one when there are none', async () => {
    mocks.getFavorites.mockResolvedValue([]);
    mocks.getFavoriteKeys.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText('No favourites yet')).toBeInTheDocument();
  });
});
