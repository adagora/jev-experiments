/**
 * Synthetic, deterministic fixtures. No real people, companies or PII —
 * everything is assembled from fragments with a seeded PRNG.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];

export type Review = { id: string; product: string; text: string };
export type Lead = { id: string; company: string; channel: string; text: string };

const PRODUCTS = [
  "Nimbus 900 blender", "Aria standing desk", "Kestrel trail shoes", "Halo LED desk lamp",
  "Trekline 40L backpack", "Sable noise-cancelling headphones", "Verve espresso maker",
  "Orbit robot vacuum", "Fable kids tablet case", "Cinder cast-iron skillet", "Lumen smart bulb 4-pack",
  "Drift memory-foam pillow", "Pulse fitness tracker", "Quill mechanical keyboard", "Brisk electric kettle",
  "Summit camping chair", "Echo bluetooth speaker", "Marlow linen sheets", "Vector bike lock",
  "Ember heated mug",
];

type Polarity = "neg" | "pos";

const OPENERS: Record<number, string[]> = {
  0: ["Absolutely terrible.", "Worst purchase I've made this year.", "Do not buy this.", "Total junk.", "I'm furious."],
  1: ["Pretty disappointed.", "Not what I hoped for.", "Underwhelming.", "Meh.", "Had higher expectations."],
  2: ["It's fine.", "Does the job, nothing more.", "Mixed feelings on this one.", "Okay product.", "Average."],
  3: ["Pretty happy with this.", "Solid buy.", "Good value overall.", "Nice little upgrade.", "Glad I got it."],
  4: ["Love it!", "Exceeded every expectation.", "Best thing I've bought in ages.", "Five stars, easily.", "Outstanding."],
};

const TOPIC_BODY: Record<string, Record<Polarity, string[]>> = {
  shipping: {
    neg: [
      "The box showed up ten days late and half crushed.",
      "Tracking said delivered but it took two more days to actually arrive.",
      "Shipping took three weeks. Three weeks!",
      "Arrived with the packaging torn open and parts loose inside.",
    ],
    pos: [
      "Ordered Monday, on my porch Wednesday morning, packed really well.",
      "Shipping was fast and the box was in perfect shape.",
      "Arrived two days early, nicely packaged.",
    ],
  },
  quality: {
    neg: [
      "The build feels flimsy and the plastic creaks when you touch it.",
      "Seams started coming apart within a week.",
      "The finish scratched the first time I used it.",
      "Materials feel cheap for what it is.",
    ],
    pos: [
      "The build quality is excellent, feels like it will last for years.",
      "Really sturdy and well made, no rattles or rough edges.",
      "Premium materials and a solid, weighty feel.",
    ],
  },
  price: {
    neg: [
      "Way overpriced for what you get.",
      "I found the exact same thing for half the price elsewhere a week later.",
      "Not worth the money at all.",
      "The price went up $30 right after I bought it, which stings.",
    ],
    pos: [
      "For the price this is a steal.",
      "Great value, cheaper than the competitors and just as good.",
      "Worth every penny.",
    ],
  },
  support: {
    neg: [
      "Customer support never replied to my two emails.",
      "Support kept me on hold for 40 minutes and then hung up.",
      "Getting a replacement through support was a nightmare.",
      "The support chatbot just loops you back to the FAQ.",
    ],
    pos: [
      "Had a question and support answered within the hour, super friendly.",
      "Customer service sent a replacement part the next day, no fuss.",
      "The support team really went above and beyond.",
    ],
  },
  other: {
    neg: [
      "The color is nothing like the photos.",
      "The instructions were confusing and partly in the wrong language.",
      "It's much bigger than I expected and doesn't fit where I planned.",
      "The app that goes with it is clunky and logs me out constantly.",
    ],
    pos: [
      "The color is exactly as pictured.",
      "Setup took two minutes with the included guide.",
      "Fits perfectly in my space and looks great.",
      "The companion app is simple and works well.",
    ],
  },
};

const DEFECTS = [
  "The motor started making a grinding noise on day three.",
  "One of the buttons stopped responding after a week.",
  "It arrived with a crack down the side.",
  "The battery won't hold a charge for more than an hour.",
  "There's a dead pixel right in the middle of the display.",
  "The lid doesn't seal and it leaks everywhere.",
  "It randomly shuts off mid-use.",
  "A stitched seam split open on the second day.",
];

const SOFTENERS = ["Only gripe:", "Minor issue, though:", "One small thing —", "Not a deal-breaker, but"];

const CLOSERS: Record<number, string[]> = {
  0: ["Returning it tomorrow.", "Avoid.", "Save your money.", "Would not recommend to anyone."],
  1: ["Probably wouldn't buy again.", "Can't really recommend it.", "Might return it.", "Looking at alternatives."],
  2: ["Might work for some people.", "No strong feelings either way.", "We'll see how it holds up.", ""],
  3: ["Would recommend.", "Happy to recommend to a friend.", "Would buy again.", ""],
  4: ["Already recommended it to three friends.", "Buy it, you won't regret it.", "Highly recommend!", "Ordering another one as a gift."],
};

export const REVIEW_TOPICS = ["shipping", "quality", "price", "support", "other"] as const;

export function generateReviews(count: number, seed = 20260917): Review[] {
  const rng = mulberry32(seed);
  const out: Review[] = [];
  for (let i = 0; i < count; i++) {
    const product = pick(rng, PRODUCTS);
    // skew slightly positive like real review data
    const level = pick(rng, [0, 0, 1, 1, 1, 2, 2, 3, 3, 3, 3, 4, 4, 4]);
    const topic = pick(rng, REVIEW_TOPICS);
    const polarity: Polarity = level <= 1 ? "neg" : level >= 3 ? "pos" : rng() < 0.5 ? "neg" : "pos";
    const parts: string[] = [pick(rng, OPENERS[level])];
    parts.push(pick(rng, TOPIC_BODY[topic][polarity]));
    // defects mostly show up in negative reviews; positive ones only mention a minor gripe
    const hasDefect =
      level <= 1 ? rng() < (topic === "quality" ? 0.75 : 0.35) : level === 2 ? rng() < 0.3 : rng() < 0.12;
    if (hasDefect) {
      const d = pick(rng, DEFECTS);
      parts.push(level >= 3 ? `${pick(rng, SOFTENERS)} ${d.charAt(0).toLowerCase()}${d.slice(1)}` : d);
    }
    if (rng() < 0.35) {
      const other = pick(rng, REVIEW_TOPICS.filter((t) => t !== topic));
      const otherPol: Polarity = rng() < 0.75 ? polarity : polarity === "neg" ? "pos" : "neg";
      parts.push(pick(rng, TOPIC_BODY[other][otherPol]));
    }
    const closer = pick(rng, CLOSERS[level]);
    if (closer) parts.push(closer);
    out.push({ id: `R-${String(i + 1).padStart(4, "0")}`, product, text: parts.join(" ") });
  }
  return out;
}

const COMPANIES = [
  "Brightwater Dental", "Copperline Logistics", "Fernhill Studios", "Granite Peak Outfitters",
  "Harbor & Vine", "Ironwood Analytics", "Juniper Home Care", "Kettle Creek Bakery",
  "Lanternfish Games", "Meadowlark Schools", "Northstar Freight", "Oakridge Clinics",
  "Pinecrest Realty", "Quarry Street Coffee", "Riverbend Credit Union", "Saltmarsh Labs",
  "Tidewater Marine", "Umber Design Co", "Violet Tree Nursery", "Westgate Fitness",
];
const CHANNELS = ["web form", "email", "chat", "LinkedIn", "referral"];

const LEAD_TEMPLATES: { intent: string; buying: number; texts: string[] }[] = [
  {
    intent: "pricing",
    buying: 3,
    texts: [
      "We have budget approved for Q4 and need a quote for 45 seats. Can you send pricing this week?",
      "What does the enterprise tier cost? We're comparing you against two other vendors and want to decide by Friday.",
      "Looking to buy for our team of 12. Is there an annual discount? Ready to move forward once I see numbers.",
      "Need pricing for 200 users and an invoice we can pay by PO. Our procurement window closes end of month.",
    ],
  },
  {
    intent: "pricing",
    buying: 1,
    texts: [
      "Just curious what your pricing looks like, no plans to switch right now.",
      "Do you have a free tier? Only exploring options for a side project.",
      "Roughly how much would this cost for a solo user? Not urgent.",
    ],
  },
  {
    intent: "demo request",
    buying: 2,
    texts: [
      "Could we schedule a demo for our operations team next week? We're evaluating a few tools.",
      "I'd like a walkthrough of the reporting features. We're mid-evaluation and this is a key requirement.",
      "Can someone show us how the integration with our CRM works? We are actively piloting alternatives.",
      "Our head of support wants to see the product in action before we commit. Any slots Thursday?",
    ],
  },
  {
    intent: "demo request",
    buying: 3,
    texts: [
      "We've decided to go with you pending a final demo for our CFO. Can we get that booked this week?",
      "Send over a demo link and the contract template — we want to sign before the quarter ends.",
    ],
  },
  {
    intent: "support",
    buying: 0,
    texts: [
      "Existing customer here. Our exports have been failing since yesterday, can someone look into it?",
      "I can't log in after the password reset, the link says it's expired.",
      "The dashboard shows last month's numbers instead of this week's. Is this a known bug?",
      "How do I add a second admin to our account? Couldn't find it in the docs.",
    ],
  },
  {
    intent: "partnership",
    buying: 1,
    texts: [
      "We run a consultancy and would love to explore a reseller or referral partnership.",
      "Interested in a co-marketing webinar with your team — we have an audience of 8k SMB owners.",
      "Would you be open to an integration partnership? We build scheduling software for clinics.",
    ],
  },
  {
    intent: "job inquiry",
    buying: 0,
    texts: [
      "Are you hiring frontend engineers? I'd love to send my resume.",
      "Do you offer internships for the summer? I'm a second-year CS student.",
      "Is the account executive role on your careers page still open?",
    ],
  },
  {
    intent: "spam",
    buying: 0,
    texts: [
      "Boost your SEO ranking with our guaranteed backlink package, reply for 70% off!!!",
      "Dear sir/madam, we offer offshore development services at $5/hour, please revert with your requirements.",
      "Congratulations, your domain has been selected for a premium listing. Claim now.",
      "We noticed your website could use more traffic. Buy 10,000 visitors today.",
    ],
  },
  {
    intent: "pricing",
    buying: 2,
    texts: [
      "We're evaluating your product for our 30-person customer service team. What's included at the mid tier, and is there onboarding help?",
      "Our current contract ends in two months. Could you share pricing and a migration overview?",
    ],
  },
];

export const LEAD_INTENTS = ["pricing", "demo request", "support", "partnership", "job inquiry", "spam"] as const;

export function generateLeads(count: number, seed = 424242): Lead[] {
  const rng = mulberry32(seed);
  const out: Lead[] = [];
  const GREETING = ["", "Hi,", "Hello,", "Hey there,", "Good morning,", "Hi team,"];
  const SUFFIX = ["", "", "", " Thanks!", " Cheers.", " Best regards.", " Let me know."];
  for (let i = 0; i < count; i++) {
    const t = pick(rng, LEAD_TEMPLATES);
    const company = pick(rng, COMPANIES);
    const intro = rng() < 0.5 ? ` I'm with ${company}.` : "";
    const greeting = pick(rng, GREETING);
    out.push({
      id: `L-${String(i + 1).padStart(4, "0")}`,
      company,
      channel: pick(rng, CHANNELS),
      text: `${greeting ? greeting + " " : ""}${pick(rng, t.texts)}${intro}${pick(rng, SUFFIX)}`.trim(),
    });
  }
  return out;
}
