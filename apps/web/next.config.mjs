/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@legal-chatbot/shared', 'react-markdown'],
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
