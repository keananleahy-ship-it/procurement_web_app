/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['snowflake-sdk'],
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
