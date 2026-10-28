import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/muyassar": ["./data/al-muyassar-fi-al-gharib.json"],
    "/api/hanswehr": ["./data/hanswehr.sqlite"],
  },
};

export default nextConfig;
