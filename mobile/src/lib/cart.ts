import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

/**
 * Supplies cart (Section 13). One seller per cart, because each order is fulfilled and paid out
 * by a single seller. Persisted so it survives restarts and poor connectivity.
 */
export interface CartItem {
  productId: string;
  name: string;
  unit: string;
  priceMinor: number;
  quantity: number;
  imageUrl?: string;
}

export interface Cart {
  sellerId: string | null;
  sellerName: string | null;
  items: CartItem[];
}

const KEY = 'hw.supplies-cart';
let cart: Cart = { sellerId: null, sellerName: null, items: [] };
const listeners = new Set<() => void>();

AsyncStorage.getItem(KEY)
  .then((raw) => {
    if (raw) {
      cart = JSON.parse(raw);
      listeners.forEach((l) => l());
    }
  })
  .catch(() => {});

function set(next: Cart) {
  cart = next;
  AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {});
  listeners.forEach((l) => l());
}

export const cartStore = {
  get: () => cart,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** Returns false (and changes nothing) if the cart holds another seller's items. */
  add(seller: { id: string; name: string }, item: CartItem, replaceOtherSeller = false): boolean {
    if (cart.sellerId && cart.sellerId !== seller.id && !replaceOtherSeller) return false;
    const base = cart.sellerId === seller.id ? cart.items : [];
    const existing = base.find((i) => i.productId === item.productId);
    const items = existing
      ? base.map((i) => (i.productId === item.productId ? { ...i, quantity: i.quantity + item.quantity } : i))
      : [...base, item];
    set({ sellerId: seller.id, sellerName: seller.name, items });
    return true;
  },
  setQty(productId: string, quantity: number) {
    const items = quantity <= 0 ? cart.items.filter((i) => i.productId !== productId) : cart.items.map((i) => (i.productId === productId ? { ...i, quantity } : i));
    set(items.length ? { ...cart, items } : { sellerId: null, sellerName: null, items: [] });
  },
  clear() {
    set({ sellerId: null, sellerName: null, items: [] });
  },
};

export function useCart(): Cart {
  return useSyncExternalStore(cartStore.subscribe, cartStore.get);
}
