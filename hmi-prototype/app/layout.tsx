import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Feed Mill Controller",
  description: "Feed mill HMI prototype",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet" />
      </head>
      <body className="h-full">{children}</body>
    </html>
  );
}
