import type { Metadata } from "next";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "새한프라텍 | 주간 생산계획표 제작지원",
  description: "주문 입력부터 생산계획표 초안, 재고, 수급 검증까지 주간 생산계획표 제작을 지원합니다.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className="h-full">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
