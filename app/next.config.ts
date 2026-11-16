import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // @anchor-lang/core's browser bundle references Node's `fs` in a code path
  // we never hit in the browser. Stub it out for client bundles.
  turbopack: {
    resolveAlias: {
      fs: { browser: "./src/lib/empty.ts" },
    },
  },
};

export default nextConfig;
