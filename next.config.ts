import type { NextConfig } from 'next';

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
const publicationBuildId = process.env.POINTSITE_BUILD_ID;
if (publicationBuildId !== undefined && !/^[a-f0-9]{64}$/.test(publicationBuildId)) {
  throw new Error('Invalid publication build identity');
}

const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  basePath,
  assetPrefix: basePath,
  images: { unoptimized: true },
  ...(publicationBuildId ? { generateBuildId: async () => publicationBuildId } : {}),
};

export default nextConfig;
