import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HNSW Live · vector search, visualized",
  description:
    "Mission control for a Qdrant Cloud collection at scale — 10,000 vectors, live HNSW traversals, and the ef_search knob in real time.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
