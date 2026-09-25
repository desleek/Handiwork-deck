import type { Persistence } from 'firebase/auth';

// `firebase/auth` resolves to the React Native build under Metro, which exports
// getReactNativePersistence, but the package's public typings omit it.
declare module 'firebase/auth' {
  export function getReactNativePersistence(storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  }): Persistence;
}
