// Blog content. Deliberately plain data (no MDX/markdown dependency) to
// match the rest of this site's zero-extra-dependency approach — see
// app/[slug]/page.tsx for the same pattern used for static content pages.
// Each post's `body` is a list of sections; a section with no `heading` is
// an intro paragraph block, rendered as prose under the post title.

export interface BlogSection {
  heading?: string;
  paragraphs: string[];
}

export interface BlogPost {
  title: string;
  excerpt: string;
  date: string; // ISO date, used for both display and sitemap lastModified
  readMinutes: number;
  body: BlogSection[];
  relatedSlug?: string; // links to an existing service page in app/[slug]
}

export const posts: Record<string, BlogPost> = {
  "how-to-activate-esim-in-nigeria": {
    title: "How to Activate an eSIM in Nigeria (iPhone and Android)",
    excerpt:
      "SIM card slots are disappearing from new phones. Here's exactly how to check if your device supports eSIM, buy a plan and get it working — on both iPhone and Android.",
    date: "2026-09-07",
    readMinutes: 5,
    relatedSlug: "travel-esim",
    body: [
      {
        paragraphs: [
          "An eSIM is a digital SIM built into your phone's hardware — there's no plastic card to insert, and no waiting for one to arrive. You buy a data plan, scan a QR code or enter an activation code, and it's live. For travel, it's usually the fastest way to get connected the moment you land, without hunting for a local SIM vendor.",
        ],
      },
      {
        heading: "1. Check your phone actually supports it",
        paragraphs: [
          "Not every phone does, and not every unit of the same model does either. On iPhone, go to Settings → General → About and look for an EID or Digital SIM entry — if it's there, your device supports eSIM. On Android, check Settings → Network & Internet → SIMs; if there's an option to add an eSIM, you're set. If you bought your phone secondhand or imported, also confirm it's carrier-unlocked — a locked phone can block eSIM activation even on a supported model.",
        ],
      },
      {
        heading: "2. Buy a plan for where you're going",
        paragraphs: [
          "Pick the country or region you actually need coverage in, and check the data allowance and validity period before paying — a 7-day plan that starts counting down from purchase, not from first use, can quietly expire before your trip does. Review these details on the plan screen; KaysPay shows the allowance, validity and price up front before you confirm.",
        ],
      },
      {
        heading: "3. Install it",
        paragraphs: [
          "Most eSIMs activate one of two ways: scanning a QR code, or entering an activation code manually if you're installing from the same phone you're activating on (you can't scan a code shown on the same screen you're scanning with). On iPhone: Settings → Cellular → Add eSIM → Use QR Code. On Android: Settings → Network & Internet → SIMs → Add eSIM, then follow the same prompt. This step needs an internet connection — do it over Wi-Fi before you travel, not after you land with no signal yet.",
        ],
      },
      {
        heading: "4. Set it as your data line",
        paragraphs: [
          "Once installed, your phone will have two lines: your regular number and the new eSIM. Go into the cellular/network settings and set the eSIM as the line used for mobile data specifically, while keeping your regular SIM active for calls and texts if you want to stay reachable on your normal number. Getting this step wrong is the most common reason people install an eSIM correctly and still don't see it being used.",
        ],
      },
      {
        heading: "If it's not working",
        paragraphs: [
          "Double check you're within the coverage area and haven't exceeded the plan's data allowance or validity window — both fail silently rather than with a clear error on most phones. Toggling Airplane Mode on and off, or restarting the phone, resolves a surprising number of \"it's installed but not connecting\" cases. If neither helps, the plan details on your KaysPay transaction history are the fastest way to confirm what you actually bought and when it expires.",
        ],
      },
    ],
  },
  "nin-vs-bvn-difference": {
    title: "NIN vs BVN: What's the Difference and Which One Do You Need?",
    excerpt:
      "Two 11-digit numbers, two different issuers, two different purposes. Here's what actually separates a NIN from a BVN — and why an app might ask you for either one.",
    date: "2026-09-07",
    readMinutes: 4,
    relatedSlug: "identity-services",
    body: [
      {
        paragraphs: [
          "If you've ever been asked for your NIN in one app and your BVN in another, and wondered whether they're the same thing, they're not — though it's an easy mix-up, since both are 11-digit numbers tied to your identity.",
        ],
      },
      {
        heading: "NIN — your national identity number",
        paragraphs: [
          "Your National Identification Number is issued by NIMC (the National Identity Management Commission) and is meant to be your single identity reference across government and, increasingly, private services in Nigeria — not tied to any bank. You get one NIN for life, generated when you enroll for a National ID.",
        ],
      },
      {
        heading: "BVN — your banking identity",
        paragraphs: [
          "Your Bank Verification Number is issued through the banking system (via NIBSS) specifically to verify who you are across every Nigerian bank you use. It's what lets banks and licensed fintechs confirm your identity before opening an account or issuing you a dedicated funding account, in line with standard Nigerian banking KYC requirements.",
        ],
      },
      {
        heading: "So which one does an app actually need?",
        paragraphs: [
          "For most everyday uses — getting a dedicated account number to fund a wallet, for instance — either your NIN or your BVN can satisfy the requirement, since both are accepted ways to verify identity for issuing a dedicated/virtual account. An app will usually ask for whichever one it needs for the specific service in front of you, so don't be surprised if a data or airtime purchase never asks for either, while setting up bank-linked funding does.",
        ],
      },
      {
        heading: "Keep both of these private",
        paragraphs: [
          "Your NIN and BVN are sensitive precisely because they unlock identity verification — treat them the same way you'd treat a password. Only ever enter them inside an official app you trust, never over WhatsApp, social media DMs, or a phone call from someone claiming to be from your bank or a government office. A legitimate request will come through the app itself, not a message asking you to \"confirm\" your number to an agent.",
        ],
      },
      {
        heading: "Verify yours free in KaysPay",
        paragraphs: [
          "KaysPay lets you verify either your NIN or your BVN directly in the app, at no cost — it's the same check described above, just done in a minute from your phone. Verifying is also what unlocks funding your wallet through your own dedicated account number, plus buying and selling crypto. Once verified, you never have to re-enter it for another service — it's a one-time step that opens the rest of the app up.",
        ],
      },
    ],
  },
  "why-is-my-transaction-pending": {
    title: "Why Is My Airtime or Data Purchase Showing \"Pending\"?",
    excerpt:
      "Pending isn't the same as failed. Here's what's actually happening behind a pending transaction, why buying again is the most common way to lose money by accident, and when it's really time to worry.",
    date: "2026-09-07",
    readMinutes: 4,
    relatedSlug: "failed-transactions",
    body: [
      {
        paragraphs: [
          "You bought airtime or data, the money left your wallet, and the transaction just says \"pending.\" It's an unsettling status precisely because it doesn't tell you which way it's going to go — and that uncertainty is exactly why it's worth understanding what it actually means.",
        ],
      },
      {
        heading: "Pending means \"still confirming,\" not \"stuck\"",
        paragraphs: [
          "When you buy airtime, data, or pay a bill, the request goes out to the actual network or biller behind the scenes — MTN, Airtel, a DisCo, whoever fulfills that specific service. Most of the time that comes back in seconds. Sometimes the provider itself is slow to respond, or a connection hiccup means the confirmation hasn't come back yet even though the request went through fine. Pending is the honest label for that in-between moment — it hasn't been rejected, it just hasn't resolved yet.",
        ],
      },
      {
        heading: "Do not buy it again",
        paragraphs: [
          "This is the single most expensive mistake people make with a pending transaction: assuming it failed and repurchasing immediately, only to have the original transaction go through minutes later too. Now you've paid twice for one delivery. Before doing anything else, check your transaction history for the original purchase and give it a reasonable window to resolve on its own.",
        ],
      },
      {
        heading: "What happens if it genuinely fails",
        paragraphs: [
          "If a provider outright rejects a purchase — an invalid number, a plan that's no longer available, that kind of thing — the amount is returned to your wallet automatically, and the transaction is recorded as refunded so there's a clear trail in your history. You don't need to request this separately for a straightforward rejection.",
        ],
      },
      {
        heading: "What happens if it just sits there",
        paragraphs: [
          "A transaction that stays unresolved doesn't just get forgotten — it's re-checked against the provider on a schedule until a real outcome is reached, rather than being left in limbo indefinitely. In the rare case something genuinely needs a human to look at it, that's exactly what that follow-up process is for.",
        ],
      },
      {
        heading: "Not every app handles this the same way",
        paragraphs: [
          "The frustrating version of \"pending\" is the one with no visible history and no automatic refund — money gone, no record of why, no idea if it's coming back. KaysPay keeps every purchase in your transaction history with its real status, refunds a genuine failure automatically without you having to ask, and keeps re-checking anything unresolved instead of dropping it. If a stuck purchase elsewhere is what brought you here, that's the actual difference worth knowing about before it happens again.",
        ],
      },
      {
        heading: "When to actually contact support",
        paragraphs: [
          "If a transaction has neither completed nor refunded after a reasonable wait, email support@kayspay.com.ng with the transaction reference from your history — that reference is what lets support find the exact transaction quickly. Never include your password, transaction PIN or a one-time code in that email; KaysPay support will never ask for any of them.",
        ],
      },
    ],
  },
  "mtn-airtel-glo-9mobile-data-comparison": {
    title: "MTN, Airtel, Glo or 9mobile: Which Network Should You Buy Data From?",
    excerpt:
      "There's no single \"best\" network in Nigeria — coverage and value both depend heavily on where you actually are. Here's what to weigh before picking one.",
    date: "2026-09-07",
    readMinutes: 4,
    relatedSlug: "airtime-data",
    body: [
      {
        paragraphs: [
          "Ask ten Nigerians which network is best and you'll get ten different, equally confident answers — and they're often all correct for where that person actually lives. Network quality in Nigeria varies significantly by state and even by neighbourhood, which matters more to your day-to-day experience than any national comparison chart.",
        ],
      },
      {
        heading: "Coverage is local, not national",
        paragraphs: [
          "A network that's excellent in Lagos can be patchy in parts of the North, and vice versa. Before committing a lot of money to one network's data plans, it's worth testing with a smaller purchase first in the specific area you'll actually be using it — your home, your workplace, wherever you spend most of your time — rather than trusting a general reputation.",
        ],
      },
      {
        heading: "What actually differs between the four",
        paragraphs: [
          "MTN and Airtel generally carry the widest overall coverage footprint across the country, which tends to make them the safer default if you travel between states often. Glo and 9mobile can offer strong value on data specifically in areas where their infrastructure is solid, but their national footprint is narrower — great if you're mostly in one place, less reliable if you move around a lot.",
        ],
      },
      {
        heading: "A practical way to decide",
        paragraphs: [
          "If you already have a working line, that's real signal — a network you've been on for months with few complaints is a safer bet than switching for a marginally cheaper plan elsewhere. If you're choosing fresh, ask people who actually live and work where you do, not a national ranking; local experience beats any general comparison every time.",
        ],
      },
      {
        heading: "Buying data across networks in one place",
        paragraphs: [
          "Whichever network you're on — or if you're managing lines across more than one — buying airtime and data from one place instead of juggling separate USSD codes and apps per network is simpler and gives you one transaction history to check when something needs confirming.",
        ],
      },
    ],
  },
};

export function getAllSlugs(): string[] {
  return Object.keys(posts);
}
