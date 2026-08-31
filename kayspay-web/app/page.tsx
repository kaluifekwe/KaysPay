import Link from "next/link";
import AppJourneyPhone from "./AppJourneyPhone";
import StoreButton from "./StoreButton";
import { PLAY_STORE_URL, ANDROID_PACKAGE } from "./store";

const services = [
  ["Airtime & data","Top up supported Nigerian mobile networks and choose from available data plans.","/airtime-data"],
  ["Electricity bills","Pay supported electricity distribution companies and retrieve available payment details.","/electricity-bills"],
  ["TV subscriptions","Renew supported DStv, GOtv and StarTimes television subscriptions.","/tv-subscriptions"],
  ["Exam PINs","Purchase supported result-checking and examination products.","/exam-pins"],
  ["Travel eSIM","Browse mobile-data packages for supported destinations.","/travel-esim"],
  ["NIN & BVN services","Access supported identity services when available and eligible.","/identity-services"],
  ["Crypto services","Buy supported crypto with naira, hold assets in your KaysPay wallet and receive automatic bank payout when you sell.","/crypto-services"],
] as const;

const providers = [
  ["MTN","mtn.png"],["Airtel","airtel.png"],["Glo","glo.png"],["9mobile","9mobile.png"],
  ["DStv","dstv.png"],["GOtv","gotv.png"],["StarTimes","startimes.png"],
  ["Ikeja Electric","ikeja-electric.png"],["Eko Electricity","eko-electric.png"],
  ["Port Harcourt Electricity","portharcourt-electric.png"],["Abuja Electricity","abuja-electric.png"],
  ["Ibadan Electricity","ibadan-electric.png"],
] as const;

const faqs = [
  ["What can I do with KaysPay?","KaysPay provides access to supported airtime, data, electricity, television, exam, eSIM, identity and other digital services from one app."],
  ["How do discounts and cashback work?","Eligible products may include an automatic discount, cashback or both. The exact price and benefit are shown before you confirm a purchase."],
  ["What should I do when a transaction is pending?","Check your transaction history and wait for the final status. Do not repeat the purchase while the first transaction is still being confirmed."],
  ["Which networks and billers are supported?","Availability can include major Nigerian mobile networks, television providers and electricity distribution companies. The latest available options appear inside KaysPay."],
  ["How does KaysPay protect transactions?","Important financial actions use server-side checks, transaction authorization, account controls and auditable records."],
  ["How do I contact support?","Email support@kayspay.com.ng with the relevant transaction reference. Never include your password, transaction PIN or one-time code."],
] as const;

export default function Home() {
  const organizationSchema = {"@context":"https://schema.org","@type":"Organization",name:"KaysPay",url:"https://kayspay.com.ng",email:"support@kayspay.com.ng",legalName:"Kay's Limited"};
  const faqSchema = {"@context":"https://schema.org","@type":"FAQPage",mainEntity:faqs.map(([name,text])=>({"@type":"Question",name,acceptedAnswer:{"@type":"Answer",text}}))};
  // Tells Google this page represents an installable Android app rather
  // than a generic business page — this is what makes an app result with
  // platform and price eligible to appear. Deliberately omits
  // aggregateRating: Google penalises self-declared ratings that don't
  // match a real review source, and the Play rating isn't ours to assert.
  const appSchema = {
    "@context":"https://schema.org",
    "@type":"MobileApplication",
    name:"KaysPay",
    operatingSystem:"Android 7.0+",
    applicationCategory:"FinanceApplication",
    installUrl:PLAY_STORE_URL,
    downloadUrl:PLAY_STORE_URL,
    url:"https://kayspay.com.ng",
    description:"Buy airtime and data, pay electricity and TV bills, buy exam PINs, travel eSIMs and crypto in Nigeria.",
    inLanguage:"en-NG",
    countriesSupported:"NG",
    identifier:ANDROID_PACKAGE,
    offers:{"@type":"Offer",price:"0",priceCurrency:"NGN"},
    publisher:{"@type":"Organization",name:"Kay's Limited"},
  };
  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{__html:JSON.stringify(organizationSchema)}}/>
    <script type="application/ld+json" dangerouslySetInnerHTML={{__html:JSON.stringify(appSchema)}}/>
    <script type="application/ld+json" dangerouslySetInnerHTML={{__html:JSON.stringify(faqSchema)}}/>
    <section className="hero"><div className="shell hero-grid"><div className="reveal"><span className="eyebrow">Digital services for everyday life in Nigeria</span><h1>Buy airtime, data <br/><em>&amp; pay bills.</em></h1><p>Use KaysPay to access supported airtime, data, electricity, television and other everyday digital services from one clear app.</p><div className="actions"><Link className="button" href="#download">Download KaysPay</Link><Link className="button ghost" href="/services">Explore services</Link></div><div className="trust"><span>Secure confirmations</span><span>Clear transaction status</span><span>Human support</span></div></div><div className="reveal-late"><AppJourneyPhone/></div></div></section>
    <section className="promo shell" aria-labelledby="promo-title"><div className="promo-copy"><span className="eyebrow promo-kicker">More value on every plan</span><h2 id="promo-title"><span>Save</span> <span>More</span><br/><em>on data &amp; more</em></h2><p>Automatic discounts on eligible purchases, with cashback on qualifying data plans.</p><div className="promo-badges"><span>Instant Discount</span><span>+ Cashback</span></div><Link className="button promo-action" href="#download">Get KaysPay</Link></div><img src="/images/cashback-customer.png" alt="Smiling KaysPay customer checking a phone"/></section>
    <section className="section shell"><div className="section-head reveal"><span className="eyebrow">KaysPay services</span><h2>Useful services in one app</h2><p>Explore each service to understand how it works. Availability and eligibility may vary by provider, network and account status.</p></div><div className="cards service-cards">{services.map(([title,description,href],index)=><article className="card card-reveal" style={{animationDelay:`${index * 90}ms`}} key={title}><span className="dot"/><h3>{title}</h3><p>{description}</p><Link className="card-link" href={href}>Learn more <span aria-hidden="true">→</span></Link></article>)}</div></section>
    <section className="provider-section"><div className="shell"><div className="section-head"><span className="eyebrow">Our trusted partners</span><h2>Working with trusted brands to serve you better</h2><p>Together with our trusted partners, KaysPay delivers reliable airtime, data, electricity, television and other essential services across Nigeria.</p></div><div className="logo-marquee" aria-label="KaysPay trusted partners"><div className="logo-track">{[...providers,...providers].map(([name,file],index)=><div className="logo-card" key={`${name}-${index}`} aria-hidden={index>=providers.length}><img src={`/images/providers/${file}`} alt={index<providers.length?name:""}/></div>)}</div></div><p className="provider-note">All trademarks and logos belong to their respective owners. Service availability may change.</p></div></section>
    <section className="section dark"><div className="shell split"><div><span className="eyebrow mint">Security by design</span><h2>Your confirmation matters.</h2><p>Financial actions are checked on the server and protected with transaction authorization, account controls and auditable records.</p><Link className="text-link" href="/security">See how KaysPay protects transactions →</Link></div><div className="security-panel" aria-label="KaysPay transaction protection"><span className="shield">✓</span><strong>Transaction protected</strong><p>Confirm important actions with your transaction PIN.</p><div><span>Server checks</span><span>Audit records</span><span>Account controls</span></div></div></div></section>
    <section className="section faq-section shell"><div className="section-head"><span className="eyebrow">Frequently asked questions</span><h2>Answers before you get started</h2></div><div className="faq-list">{faqs.map(([question,answer])=><details key={question}><summary>{question}<span aria-hidden="true">+</span></summary><p>{answer}</p></details>)}</div><Link className="text-link faq-more" href="/help">Visit the Help Center →</Link></section>
    <section className="section download-section" id="download"><div className="shell download-grid"><div><span className="eyebrow">Start with KaysPay</span><h2>One download. Everyday services.</h2><p className="lead">Download the Android app, create your account, complete the required verification and start using available KaysPay services.</p><div className="download-actions"><StoreButton location="home_download_section" /><Link className="button ghost" href="/contact">Contact support</Link></div><p className="store-note">Free to download on Android. KaysPay is a product of Kay&apos;s Limited (RC 9705891).</p></div><ol className="steps"><li><span>1</span><div><strong>Download</strong><p>Install KaysPay from its verified store listing.</p></div></li><li><span>2</span><div><strong>Create your account</strong><p>Register with your details and secure your account.</p></div></li><li><span>3</span><div><strong>Start using KaysPay</strong><p>Choose from the services available to your account.</p></div></li></ol></div></section>
  </>;
}
