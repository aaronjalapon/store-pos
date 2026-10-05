import type { NextConfig } from 'next';
import path from 'node:path';

const proxyTarget = process.env.API_PROXY_TARGET?.replace(/\/$/, '');
if (proxyTarget) {
  const url = new URL(proxyTarget);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.origin !== proxyTarget || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
    throw new Error('API_PROXY_TARGET must be an HTTPS origin (HTTP is allowed for localhost testing).');
  }
  if (proxyTarget === process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '')) {
    throw new Error('API_PROXY_TARGET must point to the API, not back to the website.');
  }
}

const nextConfig: NextConfig = {
  transpilePackages: ['@gma/contracts', '@gma/domain'],
  poweredByHeader: false,
  output: 'standalone',
  outputFileTracingRoot: path.join(process.cwd(), '../..'),
  async rewrites() {
    return proxyTarget ? [{ source: '/v1/:path*', destination: `${proxyTarget}/v1/:path*` }] : [];
  },
  async headers() {
    return [{
      source: '/v1/:path*',
      headers: [
        { key: 'Cache-Control', value: 'private, no-store' },
        { key: 'CDN-Cache-Control', value: 'no-store' },
        { key: 'Vercel-CDN-Cache-Control', value: 'no-store' },
      ],
    }];
  },
};

export default nextConfig;
