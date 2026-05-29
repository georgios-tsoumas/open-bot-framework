import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // In development the bundle is served by NestJS via @fastify/static, which
  // freezes its file routes at startup. Hashed filenames would change on every
  // rebuild and go stale (404) until a restart, so emit stable names in dev and
  // keep content-hashed names for production cache-busting.
  const isDev = mode !== 'production'

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      // VITE_WATCH is set by the watch build so it overwrites in place instead
      // of emptying client/dist (which would briefly leave Nest with no files).
      emptyOutDir: !process.env.VITE_WATCH,
      rollupOptions: isDev
        ? {
            output: {
              entryFileNames: 'assets/[name].js',
              chunkFileNames: 'assets/[name].js',
              assetFileNames: 'assets/[name].[ext]',
            },
          }
        : undefined,
    },
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:1986',
          changeOrigin: true
        }
      }
    }
  }
})
