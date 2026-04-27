/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Ensure Next.js can resolve our workspace packages.
  transpilePackages: ['@csm-chat/shared'],
  experimental: {
    typedRoutes: false,
  },
};

export default nextConfig;
