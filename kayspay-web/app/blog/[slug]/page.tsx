import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import StoreButton from "../../StoreButton";
import { posts, getAllSlugs, BlogPost } from "../posts";

const pageTitles: Record<string, string> = {
  "travel-esim": "Travel eSIM",
  "identity-services": "NIN & BVN services",
  "failed-transactions": "Failed purchases and refunds",
  "airtime-data": "Airtime & data",
};

export function generateStaticParams() {
  return getAllSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const post = posts[slug];
  if (!post) return { title: "Not found" };
  return {
    title: post.title,
    description: post.excerpt,
    alternates: { canonical: `/blog/${slug}/` },
    openGraph: { title: post.title, description: post.excerpt, url: `https://kayspay.com.ng/blog/${slug}/`, type: "article", publishedTime: post.date },
  };
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" });
}

function articleSchema(slug: string, post: BlogPost) {
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.excerpt,
    datePublished: post.date,
    dateModified: post.date,
    author: { "@type": "Organization", name: "KaysPay" },
    publisher: { "@type": "Organization", name: "KaysPay", logo: { "@type": "ImageObject", url: "https://kayspay.com.ng/images/icon.png" } },
    mainEntityOfPage: { "@type": "WebPage", "@id": `https://kayspay.com.ng/blog/${slug}/` },
  };
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = posts[slug];
  if (!post) notFound();

  return (
    <section className="page shell blog-post">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(articleSchema(slug, post)) }} />
      <Link href="/blog/" className="card-link blog-back">&larr; Back to blog</Link>
      <span className="eyebrow">KaysPay Blog</span>
      <h1>{post.title}</h1>
      <p className="blog-meta">{formatDate(post.date)} &middot; {post.readMinutes} min read</p>
      <article className="blog-article">
        {post.body.map((section, i) => (
          <div key={i}>
            {section.heading && <h2>{section.heading}</h2>}
            {section.paragraphs.map((p, j) => <p key={j}>{p}</p>)}
          </div>
        ))}
      </article>
      {post.relatedSlug && pageTitles[post.relatedSlug] && (
        <p className="blog-related">
          Related: <Link href={`/${post.relatedSlug}/`}>{pageTitles[post.relatedSlug]}</Link>
        </p>
      )}
      <div className="page-cta">
        <span><strong>Ready to use KaysPay?</strong><small>Free on Android. Create your account in minutes.</small></span>
        <StoreButton location={`blog_${slug}`} className="button" />
      </div>
    </section>
  );
}
