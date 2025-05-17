// vitest.workspace.ts
import { defineWorkspace } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineWorkspace([
  {
    // Client workspace
    root: 'client',
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(process.cwd(), 'client/src'),
        '@shared': path.resolve(process.cwd(), 'shared'),
        '@assets': path.resolve(process.cwd(), 'attached_assets'),
      },
    },
    test: {
      name: 'client',
      include: ['__tests__/**/*.test.{ts,tsx}'],
      environment: 'jsdom',
      setupFiles: ['./__tests__/setupTests.ts'],
      globals: true,
    },
  },
  {
    // Server workspace
    root: 'server',
    resolve: {
      alias: {
        '@shared': path.resolve(process.cwd(), 'shared'),
      },
    },
    test: {
      name: 'server',
      include: ['__tests__/**/*.test.ts'],
      environment: 'node',
      globals: true,
    },
  },
  {
    // Shared workspace
    root: 'shared',
    test: {
      name: 'shared',
      include: ['__tests__/**/*.test.ts'],
      environment: 'node',
      globals: true,
    },
  },
])
