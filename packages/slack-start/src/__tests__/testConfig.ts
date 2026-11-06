/** Snapshot of GET /api/onboarding/slack-start/config (backend slackStartConfig.ts) for widget tests. */
import type { SlackStartConfig } from '../types';

export const TEST_CONFIG: SlackStartConfig = {
  "version": 1,
  "brand": {
    "name": "AgentWeb"
  },
  "steps": [
    {
      "id": "start",
      "kind": "start",
      "heading": "Let's set up your growth team",
      "subline": "We'll open a private Slack channel for you with our team and agents.",
      "cta": "Continue",
      "fields": {
        "email": {
          "label": "Work email",
          "placeholder": "you@company.com"
        },
        "website": {
          "label": "Company website",
          "placeholder": "company.com"
        }
      }
    },
    {
      "id": "source",
      "kind": "single",
      "heading": "How did you find AgentWeb?",
      "subline": "Pick the closest match – you can always change this later.",
      "options": [
        {
          "id": "linkedin",
          "label": "LinkedIn"
        },
        {
          "id": "x",
          "label": "Twitter / X"
        },
        {
          "id": "reddit",
          "label": "Reddit"
        },
        {
          "id": "google",
          "label": "Google"
        },
        {
          "id": "ai_assistant",
          "label": "ChatGPT / Claude / Perplexity"
        },
        {
          "id": "product_hunt",
          "label": "Product Hunt"
        },
        {
          "id": "referral",
          "label": "A friend or colleague"
        },
        {
          "id": "event",
          "label": "An event"
        },
        {
          "id": "slack_marketplace",
          "label": "Slack Marketplace"
        },
        {
          "id": "newsletter_podcast",
          "label": "A newsletter or podcast"
        }
      ]
    },
    {
      "id": "role",
      "kind": "single",
      "heading": "What's your role?",
      "subline": "This helps our agents tailor suggestions to how you work.",
      "options": [
        {
          "id": "founder",
          "label": "Founder / CEO"
        },
        {
          "id": "head_of_growth",
          "label": "Head of Marketing / Growth"
        },
        {
          "id": "marketing_ic",
          "label": "Marketing manager or specialist"
        },
        {
          "id": "agency",
          "label": "Agency owner / freelancer"
        },
        {
          "id": "sales_revops",
          "label": "Sales / RevOps"
        },
        {
          "id": "other",
          "label": "Something else"
        }
      ]
    },
    {
      "id": "sector",
      "kind": "multi",
      "heading": "What does your company sell?",
      "subline": "Select all that apply.",
      "options": [
        {
          "id": "agency",
          "label": "Agency / freelance – serve multiple clients"
        },
        {
          "id": "saas",
          "label": "SaaS / technology"
        },
        {
          "id": "ecommerce",
          "label": "E-commerce / DTC"
        },
        {
          "id": "professional_services",
          "label": "Professional services – legal, consulting, finance"
        },
        {
          "id": "local_services",
          "label": "Local & field services – trades, health, real estate"
        },
        {
          "id": "media_apps",
          "label": "Media, apps & entertainment"
        }
      ]
    },
    {
      "id": "tools",
      "kind": "multi",
      "heading": "Which tools does your growth run on?",
      "subline": "This helps our agents speak your language from the first message.",
      "note": "Nothing gets connected here. Our agents ask for each login in Slack, only when a task needs it.",
      "options": [
        {
          "id": "meta_ads",
          "label": "Meta Ads",
          "group": "Ad channels"
        },
        {
          "id": "google_ads",
          "label": "Google Ads",
          "group": "Ad channels"
        },
        {
          "id": "linkedin_ads",
          "label": "LinkedIn Ads",
          "group": "Ad channels"
        },
        {
          "id": "hubspot",
          "label": "HubSpot",
          "group": "CRM, email & site"
        },
        {
          "id": "activecampaign",
          "label": "ActiveCampaign",
          "group": "CRM, email & site"
        },
        {
          "id": "shopify",
          "label": "Shopify",
          "group": "CRM, email & site"
        },
        {
          "id": "webflow",
          "label": "Webflow",
          "group": "CRM, email & site"
        },
        {
          "id": "wordpress",
          "label": "WordPress",
          "group": "CRM, email & site"
        },
        {
          "id": "google_analytics",
          "label": "Google Analytics",
          "group": "CRM, email & site"
        }
      ]
    },
    {
      "id": "adSpend",
      "kind": "single",
      "heading": "How much do you spend on ads per month?",
      "subline": "Rough is fine. It sets how hands-on we get.",
      "cta": "Create my Slack channel",
      "options": [
        {
          "id": "none",
          "label": "Nothing yet"
        },
        {
          "id": "under_1k",
          "label": "Under $1k"
        },
        {
          "id": "1k_5k",
          "label": "$1k – $5k"
        },
        {
          "id": "5k_20k",
          "label": "$5k – $20k"
        },
        {
          "id": "20k_100k",
          "label": "$20k – $100k"
        },
        {
          "id": "100k_plus",
          "label": "$100k+"
        }
      ]
    }
  ],
  "buttons": {
    "continue": "Continue",
    "back": "Back",
    "retry": "Try again",
    "finish": "Create my Slack channel",
    "close": "Close"
  },
  "screens": {
    "gettingReady": {
      "heading": "Your team is getting ready",
      "subline": "Setting up your private Slack channel with our team and agents."
    },
    "pending": {
      "heading": "You're on the list",
      "body": "We're setting up your private Slack channel. Keep an eye on your inbox — we'll email you as soon as it's ready."
    },
    "ready": {
      "heading": "Check Slack",
      "body": "Your private channel is ready. Look for the Slack invitation in Slack or your email."
    }
  },
  "errors": {
    "generic": "Something went wrong. Please try again.",
    "saveFailed": "We couldn't save that. Check your connection and try again.",
    "invalidEmail": "Enter a valid email address.",
    "personalEmail": "Please use your work email.",
    "invalidWebsite": "Enter your public company website, like company.com.",
    "captcha": "We couldn't verify you're human. Please try again.",
    "rateLimited": "Too many attempts. Please wait a few minutes and try again.",
    "domainInProgress": "Someone from your company already started setting up AgentWeb. Check your inbox or ask your teammate to add you.",
    "accountExists": "You already have an AgentWeb account. Sign in at app.agentweb.pro.",
    "selectOne": "Pick one option to continue.",
    "selectAtLeastOne": "Pick at least one option to continue."
  },
  "captcha": null
}
;
