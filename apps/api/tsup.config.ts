import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { server: 'src/server.ts', worker: 'src/worker.ts', migrate: 'src/db/migrate.ts' },
  format: ['esm'],
  target: 'node20',
  clean: true,
  splitting: false,
  // The shared workspace package ships TypeScript source; bundle it in.
  noExternal: ['@handiwork/shared'],
});
