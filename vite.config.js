import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react(), {
    name: 'jibonguard-react-route-fallback',
    configureServer(server) {
      const reactRoutes = new Set(['/dashboard.html', '/account.html', '/privacy.html', '/signup.html', '/verify.html', '/resend-verification.html', '/login.html', '/admin']);
      server.middlewares.use((req, _res, next) => {
        const url = req.url || '/';
        const pathname = url.split('?')[0];
        if (reactRoutes.has(pathname)) req.url = `/index.html${url.slice(pathname.length)}`;
        next();
      });
    },
  }],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8000' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
