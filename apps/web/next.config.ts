import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  transpilePackages: ['@gma/contracts', '@gma/domain'],
  poweredByHeader: false,
  outputFileTracingRoot: path.join(process.cwd(), '../..'),
};

export default nextConfig;
