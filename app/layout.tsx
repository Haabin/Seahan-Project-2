import type { Metadata } from "next";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "주간 생산계획 수립 지원 툴",
  description: "새한프라텍 오창 1공장 1-Stage 주간 생산계획 수립·검증·씨벌크 원료 예측",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className="h-full">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
