import type { Metadata } from "next";
import Link from "next/link";
import { posts } from "./posts";

export const metadata: Metadata = {
  title: "Blog",
  description: "Practical guides on airtime, data, eSIM, identity verification and everyday digital payments in Nigeria.",
  alternates: { canonical: "/blog/" },
  openGraph: { title: "KaysPay Blog", description: "Practical guides on airtime, data, eSIM, identity verification and everyday digital payments in Nigeria.", url: "https://kayspay.com.ng/blog/" },
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" });
}

export default function BlogIndex() {
  const entries = Object.entries(posts).sort(([, a], [, b]) => b.date.localeCompare(a.date));
  return (
    <section className="page shell">
      <span className="eyebrow">KaysPay Blog</span>
      <h1>Guides for everyday payments in Nigeria</h1>
      <p className="lead">Practical answers to the questions people actually search for — airtime, data, eSIM, identity verification and more.</p>
      <div className="blog-grid">
        {entries.map(([slug, post]) => (
          <Link key={slug} href={`/blog/${slug}/`} className="blog-card">
            <span className="blog-card-date">{formatDate(post.date)} &middot; {post.readMinutes} min read</span>
            <h2>{post.title}</h2>
            <p>{post.excerpt}</p>
            <span className="card-link">Read more &rarr;</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
