import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 계획·재고 데이터는 요청마다 최신값을 읽어야 하므로 Cache Components를 쓰지 않는다(이전 캐싱 모델).
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  serverExternalPackages: ["exceljs", "postgres"],
};

export default nextConfig;
