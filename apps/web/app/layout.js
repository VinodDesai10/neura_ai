import "./globals.css";

export const metadata = {
  title: "AiNeura Demo",
  description: "Memory-centric chat app MVP"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

