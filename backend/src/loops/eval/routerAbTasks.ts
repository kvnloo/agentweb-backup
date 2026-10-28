/**
 * ENG-2649: the synthetic task set for the router A/B (routerAb.ts). No customer data: eight fictional brands on
 * RFC 2606 `.example` domains, five templates per task type, so 40 tasks per type. Report numbers come from a seeded
 * generator, so the set is identical on every machine (`taskSetFingerprint` pins it in every run's output).
 *
 * Prompts follow the shape the product sends for each flow: reports mirror the customer portal's Research Reports
 * prompt (brief + brand + audience, with `create_blog_article` required), image/video mirror the Images/Videos pages
 * (`generate_image` / `generate_video` required), support is a question typed into the Emma sidebar.
 */
import type { AgentWebTaskType } from '../../services/agentMode/agentWebModelRouter';
import { mulberry32, type AbTask } from './routerAb';

export const ROUTER_AB_TASK_SET_VERSION = 'router-ab-tasks-v1';

interface Brand {
  id: string;
  name: string;
  domain: string;
  category: string;
  product: string;
  audience: string;
  colors: string;
  tone: string;
  offer: string;
  event: string;
  market: string;
}

const BRANDS: Brand[] = [
  { id: 'brightloom', name: 'Brightloom Candles', domain: 'brightloom.example', category: 'DTC home fragrance', product: 'the Cedar & Fig soy candle', audience: 'urban renters aged 25-40 who decorate on a budget', colors: 'warm amber (#E8A33D) and charcoal (#2B2B2B)', tone: 'cosy and understated', offer: '20% off the autumn collection', event: 'the autumn collection launch on 1 November', market: 'the UK' },
  { id: 'northpeak', name: 'Northpeak Gear', domain: 'northpeak.example', category: 'outdoor apparel', product: 'the Ridgeline waterproof shell jacket', audience: 'weekend hikers aged 30-55', colors: 'forest green (#1F4D3A) and signal orange (#F26B1D)', tone: 'rugged and practical', offer: 'free shipping on orders over $100', event: 'the winter gear sale starting 15 November', market: 'Canada' },
  { id: 'ledgerly', name: 'Ledgerly', domain: 'ledgerly.example', category: 'B2B SaaS invoicing for freelancers', product: 'automatic late-payment reminders', audience: 'freelance designers and developers billing 5-30 clients', colors: 'indigo (#3B3FD8) and white', tone: 'clear and reassuring', offer: 'a 30-day free trial', event: 'the launch of multi-currency invoicing', market: 'the US' },
  { id: 'pawsome', name: 'Pawsome Bites', domain: 'pawsomebites.example', category: 'premium dog treats', product: 'single-ingredient salmon chews', audience: 'dog owners who read ingredient labels', colors: 'teal (#1BA39C) and cream (#FFF4E0)', tone: 'playful and warm', offer: 'buy two bags, get one free', event: 'National Dog Day', market: 'Australia' },
  { id: 'verde', name: 'Verde Table', domain: 'verdetable.example', category: 'plant-based meal kits', product: 'the 20-minute weeknight box', audience: 'busy couples trying to eat less meat', colors: 'leaf green (#4CAF50) and tomato red (#E5533D)', tone: 'upbeat and practical', offer: 'half price on the first box', event: 'the January "Fresh Start" campaign', market: 'Germany' },
  { id: 'kitecraft', name: 'Kitecraft Academy', domain: 'kitecraft.example', category: 'online coding school for kids', product: 'the 8-week Python for Kids course', audience: 'parents of children aged 9-14', colors: 'sky blue (#38A1F3) and sunshine yellow (#FFD23F)', tone: 'encouraging and friendly', offer: 'a free trial lesson', event: 'spring term enrolment opening on 1 March', market: 'India' },
  { id: 'harborline', name: 'Harborline Dental', domain: 'harborline.example', category: 'local dental clinic group (4 clinics)', product: 'same-week Invisalign consultations', audience: 'adults aged 25-45 within 10 miles of the clinics', colors: 'navy (#14213D) and mint (#9FE2BF)', tone: 'calm and trustworthy', offer: 'a free first consultation', event: 'the opening of a fifth clinic in Riverside', market: 'a mid-sized US city' },
  { id: 'solace', name: 'Solace Sleep', domain: 'solacesleep.example', category: 'mattresses and sleep tech', product: 'the Solace Hybrid mattress with a 100-night trial', audience: 'adults aged 30-60 with back pain', colors: 'midnight blue (#1B2A49) and soft lavender (#C9B6E4)', tone: 'soothing and evidence-led', offer: '$200 off plus two free pillows', event: 'the Black Friday sale', market: 'the US' },
];

/** Seeded 3-month x 3-channel paid performance table for one brand (synthetic; the judge checks figures against it). */
export function syntheticPerformanceTable(brandIndex: number): string {
  const rand = mulberry32(2649 + brandIndex);
  const rows = ['| Month | Channel | Spend ($) | Impressions | Clicks | Conversions | Revenue ($) |', '|---|---|---|---|---|---|---|'];
  for (const month of ['July', 'August', 'September']) {
    for (const channel of ['Meta', 'Google Search', 'TikTok']) {
      const spend = Math.round(2_000 + rand() * 8_000);
      const cpm = 4 + rand() * 12;
      const impressions = Math.round((spend / cpm) * 1_000);
      const clicks = Math.round(impressions * (0.006 + rand() * 0.02));
      const conversions = Math.round(clicks * (0.01 + rand() * 0.05));
      const revenue = Math.round(conversions * (30 + rand() * 120));
      rows.push(`| ${month} | ${channel} | ${spend} | ${impressions} | ${clicks} | ${conversions} | ${revenue} |`);
    }
  }
  return rows.join('\n');
}

/** The portal's Research Reports prompt shape: brief, brand guidelines, business overview, audience. */
function reportPrompt(b: Brand, brief: string): string {
  return `Report Prompt: ${brief}

Brand Guidelines:
- Brand Name: ${b.name}
- Website: https://${b.domain}
- Tone: ${b.tone}
- Brand Colors: ${b.colors}

Business Overview:
${b.name} is a ${b.category} business selling ${b.product}, mainly in ${b.market}.

Target Audience: ${b.audience}
`;
}

const TEMPLATES: Record<'report' | 'support' | 'image' | 'video', Array<(b: Brand, i: number) => Omit<AbTask, 'taskId' | 'taskType' | 'synthetic' | 'brand'>>> = {
  report: [
    (b, i) => ({
      prompt: reportPrompt(b, `Write a Q3 paid-media performance report for ${b.name} from the data below. Compare channels on CPA and ROAS, call out the month-over-month trend, and recommend how to split next quarter's budget.\n\n${syntheticPerformanceTable(i)}`),
      requiredTools: ['create_blog_article'],
      judgeNotes: 'Every figure in the report (spend, CPA, ROAS, totals, percentages) must be derivable from the table in the request. Arithmetic errors or invented figures are a grounding fault.',
    }),
    (b) => ({
      prompt: reportPrompt(b, `Write a competitive landscape report for ${b.name} in the ${b.category} market in ${b.market}: the types of competitors, how they position and price, where ${b.name} can differentiate, and three positioning moves for the next 6 months. You have no live market data; state assumptions explicitly.`),
      requiredTools: ['create_blog_article'],
      judgeNotes: 'No market data was supplied: specific competitor names, market sizes or statistics presented as fact are fabrication unless labelled as assumptions or examples.',
    }),
    (b) => ({
      prompt: reportPrompt(b, `Write a customer persona research report for ${b.name}: 3 personas within the target audience, each with goals, objections, buying triggers, preferred channels and the message most likely to convert them.`),
      requiredTools: ['create_blog_article'],
    }),
    (b) => ({
      prompt: reportPrompt(b, `Write a go-to-market plan report for ${b.event}: objectives, audience, channel plan with rough budget split for a $25,000 budget, a 4-week timeline, and the KPIs to track.`),
      requiredTools: ['create_blog_article'],
      judgeNotes: 'The budget split must add up to the stated $25,000 budget.',
    }),
    (b) => ({
      prompt: reportPrompt(b, `Write an SEO content-gap report for https://${b.domain}: the 10 topic clusters ${b.name} should own, search intent for each, a suggested pillar article per cluster, and a 3-month publishing calendar. You have no keyword-volume data; do not invent volumes.`),
      requiredTools: ['create_blog_article'],
      judgeNotes: 'No keyword data was supplied: invented search volumes or difficulty scores presented as fact are fabrication.',
    }),
  ],
  support: [
    (b) => ({ prompt: `Our ${b.name} Meta campaign spent 40% more this week but conversions stayed flat. What should I check first, and in what order?`, requiredTools: [] }),
    (b) => ({ prompt: `I run marketing for ${b.name}. Our weekly report email didn't arrive this Monday. What are the likely causes and how do I check which one it is?`, requiredTools: [] }),
    (b) => ({ prompt: `For ${b.name}, should I use a lookalike audience or broad targeting for a new prospecting campaign with a $50/day budget? Explain the trade-off briefly and give me your recommendation.`, requiredTools: [] }),
    (b) => ({ prompt: `Our ${b.name} ads got rejected for "misleading claims". The headline was "The only ${b.product} you'll ever need". How do I fix it and get it re-approved quickly?`, requiredTools: [] }),
    (b) => ({ prompt: `I want to pause everything for ${b.name} over a 3-day holiday without losing the learning phase. What's the safest way to do it?`, requiredTools: [] }),
  ],
  image: [
    (b) => ({ prompt: `Create a square (1:1) Instagram feed ad for ${b.name} promoting ${b.offer}. Show ${b.product}. Brand colors: ${b.colors}. On-image headline, exactly: "${b.offer.charAt(0).toUpperCase()}${b.offer.slice(1)}". Tone: ${b.tone}.`, requiredTools: ['generate_image'] }),
    (b) => ({ prompt: `Make a 9:16 story image announcing ${b.event} for ${b.name}. Use the brand colors ${b.colors}, keep text to the event name and date only, and leave the bottom 20% clear for the swipe-up.`, requiredTools: ['generate_image'] }),
    (b) => ({ prompt: `Generate a lifestyle product photo of ${b.product} for ${b.name}, shown in a setting that fits ${b.audience}. No text on the image. Natural light, ${b.tone} mood.`, requiredTools: ['generate_image'] }),
    (b) => ({ prompt: `Create three square ad variations for ${b.name} testing three angles: price (${b.offer}), quality, and social proof. Same product (${b.product}) and brand colors (${b.colors}) in all three; one short headline each.`, requiredTools: ['generate_image'] }),
    (b) => ({ prompt: `Design a 16:9 homepage hero banner for https://${b.domain} featuring ${b.product}, with space on the left third for a headline that will be added in HTML later (so no text in the image). Colors: ${b.colors}.`, requiredTools: ['generate_image'] }),
  ],
  video: [
    (b) => ({ prompt: `Create an 8-second vertical (9:16) video ad for ${b.name} showing ${b.product}, ending on the line "${b.offer}". Brand colors ${b.colors}, ${b.tone} tone.`, requiredTools: ['generate_video'] }),
    (b) => ({ prompt: `Make a short teaser video (about 6 seconds, 1:1) for ${b.event} by ${b.name}. Build anticipation; reveal the date at the end.`, requiredTools: ['generate_video'] }),
    (b) => ({ prompt: `Generate a UGC-style vertical clip for ${b.name}: a customer from the audience (${b.audience}) unboxing or using ${b.product} and reacting naturally. No logos other than ${b.name}.`, requiredTools: ['generate_video'] }),
    (b) => ({ prompt: `Create a looping product demo video (16:9, ~8 seconds) of ${b.product} for the ${b.name} website, clean background in ${b.colors}, no voiceover.`, requiredTools: ['generate_video'] }),
    (b) => ({ prompt: `Produce a seasonal promo video for ${b.name} for ${b.market}, promoting ${b.offer}, vertical format for Reels, with on-screen text and an upbeat feel.`, requiredTools: ['generate_video'] }),
  ],
};

/** The full v1 set: 8 brands x 5 templates for each of report, support, image and video (160 tasks). */
export function buildSyntheticTaskSet(): AbTask[] {
  const tasks: AbTask[] = [];
  for (const taskType of Object.keys(TEMPLATES) as Array<keyof typeof TEMPLATES>) {
    TEMPLATES[taskType].forEach((template, t) => {
      BRANDS.forEach((brand, i) => {
        tasks.push({
          taskId: `${taskType}-t${t + 1}-${brand.id}`,
          taskType: taskType as AgentWebTaskType,
          synthetic: true,
          brand: brand.name,
          template: `${taskType}-t${t + 1}`,
          ...template(brand, i),
        });
      });
    });
  }
  return tasks;
}
