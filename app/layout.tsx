import { Inter } from "next/font/google";

import { AuthProvider } from "@/components/AuthProvider";
import { ToastProvider } from "@/components/providers/ToastProvider";
import { getServerSession } from "@/lib/auth/serverSession";

import "./globals.css";

const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata = {
  title: "Single Solution Portal",
  description: "Company portal for merchants and platform administration",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();

  return (
    <html lang="en" className={sans.variable}>
      <body className={`${sans.className} min-h-screen antialiased`}>
        <AuthProvider initialUser={session?.user ?? null}>
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
