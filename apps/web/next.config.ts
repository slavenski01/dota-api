import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["@dota/jobs", "@dota/persistence", "pg", "pg-boss"],
  async headers() {
    return [{ source: "/heroes/:filename([0-9]+\\.[a-f0-9]{16}\\.png)", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] }];
  },
};

export default config;
