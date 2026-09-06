import type { Metadata } from "next";
import Link from "next/link";
import "./styles.css";
import AnalyticsConsent from "./analytics-consent";

export const metadata: Metadata = {
  metadataBase: new URL("https://kayspay.com.ng"),
  title: { default: "Buy Airtime, Data and Pay Bills Online | KaysPay", template: "%s | KaysPay" },
  description: "Buy airtime and data, pay electricity and TV bills, access eSIMs and use supported digital services in Nigeria with KaysPay.",
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: { title: "KaysPay", description: "Pay smarter. Live easier.", url: "https://kayspay.com.ng", siteName: "KaysPay", images: ["/images/icon.png"], type: "website" },
  icons: { icon: "/images/icon.png" },
};

const nav = [["Home","/"],["Services","/services"],["Blog","/blog"],["About","/about"],["Help","/help"]];
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>
    <header><div className="nav shell"><Link className="brand" href="/"><img src="/images/icon.png" alt=""/>KaysPay</Link><nav>{nav.map(([n,h])=><Link key={h} href={h}>{n}</Link>)}</nav></div></header>
    <main>{children}</main>
    <footer><div className="shell footer-grid"><div><div className="brand light">KaysPay</div><p>Everyday payments, made simple.</p></div><div><strong>Company</strong><Link href="/about">About</Link><Link href="/security">Security</Link><Link href="/contact">Contact</Link></div><div><strong>Guides</strong><Link href="/blog">Blog</Link><Link href="/choosing-a-vtu-app">Choosing a VTU app</Link><Link href="/failed-transactions">Failed purchases and refunds</Link><Link href="/pay-bills-from-abroad">Paying bills from abroad</Link></div><div><strong>Legal</strong><a href="/privacy/">Privacy &amp; Terms</a><a href="/#analytics-preferences">Analytics preferences</a><a href="/delete-account/">Delete account</a></div></div><div className="shell fine">KaysPay is a product of Kay&apos;s Limited (RC 9705891). © 2026 Kay&apos;s Limited.</div></footer>
    <AnalyticsConsent />
  </body></html>;
}
