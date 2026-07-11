/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // transformers.js runs in the browser only — keep it and its native deps
  // (onnxruntime-node, sharp) out of the server bundle entirely.
  serverExternalPackages: ["@xenova/transformers"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push("@xenova/transformers");
    }
    config.resolve.alias = {
      ...config.resolve.alias,
      "onnxruntime-node": false,
      sharp: false,
    };
    return config;
  },
};

export default nextConfig;
