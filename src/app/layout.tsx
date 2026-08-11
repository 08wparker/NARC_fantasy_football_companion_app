import { ClerkProvider, Show, SignInButton, UserButton } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";

import { Logo } from "@/components/logo";
import { MembershipBadge } from "@/components/membership-badge";

import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "NARC — North Adams Rowing Club",
  description: "Draft-pick ledger and rule votes for the NARC keeper league",
};

const NAV = [
  { href: "/", label: "Home" },
  { href: "/draft-board", label: "Draft board" },
  { href: "/trades", label: "Trades" },
  { href: "/rules", label: "Rules" },
  { href: "/commissioner", label: "Commissioner" },
];

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* Clerk 7 requires the provider INSIDE <body>. */}
        <ClerkProvider>
          <header className="border-b border-border bg-surface/60 backdrop-blur sticky top-0 z-20">
            <div className="mx-auto max-w-6xl px-4 h-14 flex items-center gap-6">
              <Link href="/" className="flex items-center gap-2.5 shrink-0 group">
                <Logo className="h-8 w-auto" title="NARC — North Adams Rowing Club" />
                <span className="leading-none">
                  <span className="block font-semibold tracking-tight text-accent">NARC</span>
                  <span className="hidden sm:block text-[11px] text-muted tracking-wide">
                    North Adams Rowing Club
                  </span>
                </span>
              </Link>

              <nav className="flex items-center gap-1 text-sm overflow-x-auto">
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="px-3 py-1.5 rounded-md text-muted hover:text-foreground hover:bg-surface-2 transition-colors whitespace-nowrap"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>

              <div className="ml-auto flex items-center gap-3 shrink-0">
                {/*
                  Suspense boundary because MembershipBadge hits Clerk + the DB.
                  A layout that awaits data blocks navigation and loading.js
                  will not show, so the boundary has to be here.
                */}
                <Suspense fallback={<div className="h-7 w-24 rounded bg-surface-2 animate-pulse" />}>
                  <MembershipBadge />
                </Suspense>

                {/* Clerk 7 replaced <SignedIn>/<SignedOut> with <Show>. */}
                <Show when="signed-out">
                  <SignInButton mode="modal">
                    <button className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-background hover:bg-accent/90 transition-colors">
                      Sign in
                    </button>
                  </SignInButton>
                </Show>
                <Show when="signed-in">
                  <UserButton />
                </Show>
              </div>
            </div>
          </header>

          <main className="flex-1 mx-auto w-full max-w-6xl px-4 py-8">{children}</main>

          <footer className="border-t border-border py-6 text-center text-xs text-muted">
            North Adams Rowing Club · draft picks, slot swaps and keeper rights live here because ESPN cannot track them.
          </footer>
        </ClerkProvider>
      </body>
    </html>
  );
}
