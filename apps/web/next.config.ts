import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["@dota/jobs", "@dota/persistence", "pg", "pg-boss"],
};

export default config;
