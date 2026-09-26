import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * Section 12: the Marketplace / Deals module can be switched off by admins.
 * Tabs stay hidden until the API says it's on, so a disabled (or failing)
 * module never shows up.
 */
export function useMarketplaceEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    api<{ enabled: boolean }>('/marketplace/status')
      .then((r) => live && setEnabled(r.enabled))
      .catch(() => live && setEnabled(false));
    return () => {
      live = false;
    };
  }, []);
  return enabled;
}

export const PLACEMENT_LABEL = { featured_seller: 'Featured seller card', brand_card: 'Brand card', sponsored_search: 'Sponsored search result' } as const;
export const PRICING_LABEL = { flat_daily: 'per day', cpm: 'per 1,000 views', cpc: 'per click' } as const;
