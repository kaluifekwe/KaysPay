import type { NextConfig } from "next";
const config: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  turbopack: { root: process.cwd() },
  agentRules: false,
};
export default config;
