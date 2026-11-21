// The golden set (docs/QA-SPEC.md "Prompt regression"): 5 FAKE brands across
// niches and languages. `npm run eval:scripts` writes a script for each and
// runs Gates 1 and 2; compare the pass rate and voice scores whenever a
// prompt in /prompts changes. Brand #1 also feeds the sample snapshot test.
// None of these people or businesses are real.
import type { PronunciationEntry } from "@/lib/pronunciation/dictionary";
import type { PlanId } from "@/lib/plans";
import type { QaBrand } from "@/lib/qa/script-pipeline";
import type { ScriptPost } from "@/lib/scripts";

export type GoldenBrand = {
  /** Short label for the report table. */
  key: string;
  brand: QaBrand;
  plan: PlanId;
  post: ScriptPost;
  dictionary: PronunciationEntry[];
};

export const GOLDEN_BRANDS: GoldenBrand[] = [
  {
    key: "doctor-en",
    plan: "creator",
    brand: {
      id: "90000000-0000-0000-0000-000000000001",
      name: "Dr Ayesha Clinic",
      niche: "doctor",
      audience: "parents in Lahore",
      offers: "Online consultation for Rs 2,999; Family health check for Rs 7,500",
      tone: "Warm, calm, practical",
      sound_answers: {
        greeting: "Assalam o alaikum, I'm Dr Ayesha",
        phrases: "Seedhi baat",
        never_say: "Guaranteed cure",
      },
      samples:
        "Fever is the body doing its job. Watch the child, not the thermometer.\n\n---\n\nMost coughs settle in a week. If breathing looks hard, come in the same day.\n\n---\n\nI'd rather you ask a silly question than wait at home worried.",
      banned_words: ["miracle", "cure"],
      language: "en",
      profile_md: "Family doctor in Gulberg, Lahore. Talks to parents in plain words. Offers online consultations and family health checks.",
      pillars: [{ name: "Fever myths", description: "Common fever myths parents believe." }],
      words_per_second: 2.4,
      is_managed: true,
      autopilot_level: "review_everything",
    },
    post: {
      id: "91000000-0000-0000-0000-000000000001",
      title: "Fever: when to worry",
      hook: "When is a child's fever serious?",
      pillar: "Fever myths",
      format: "talking",
    },
    dictionary: [
      { written: "Ayesha", say_as: "aa-ye-sha", status: "approved" },
      { written: "Gulberg", say_as: "gul-berg", status: "approved" },
    ],
  },
  {
    key: "real-estate-roman-urdu",
    plan: "pro",
    brand: {
      id: "90000000-0000-0000-0000-000000000002",
      name: "Bilal Properties",
      niche: "real_estate",
      audience: "pehli dafa ghar khareedne wale families",
      offers: "Free site visit in DHA Lahore; Plot booking guidance",
      tone: "Dosti wala, seedha",
      sound_answers: { greeting: "Assalam o alaikum doston", phrases: "Aaj ki baat", never_say: "Guaranteed profit" },
      samples:
        "Plot lene se pehle file ki tasdeeq zaroor karwain.\n\n---\n\nSasta plot hamesha acha deal nahi hota. Location dekhein, phir qeemat.\n\n---\n\nAaj ki baat: installment plan ka total hisaab pehle lagayein.",
      banned_words: ["guaranteed profit", "double"],
      language: "roman_urdu",
      profile_md: "Real-estate adviser in DHA Lahore. Speaks Roman Urdu to first-time buyers.",
      pillars: [{ name: "Buying basics", description: "Pehli dafa khareedne walon ke liye basics." }],
      words_per_second: 2.6,
      is_managed: true,
      autopilot_level: "review_videos",
    },
    post: {
      id: "91000000-0000-0000-0000-000000000002",
      title: "File verification kyun zaroori hai",
      hook: "Plot khareedne se pehle yeh ghalti mat karein?",
      pillar: "Buying basics",
      format: "talking",
    },
    dictionary: [{ written: "DHA", say_as: "D H A", status: "approved" }],
  },
  {
    key: "coach-hinglish",
    plan: "creator",
    brand: {
      id: "90000000-0000-0000-0000-000000000003",
      name: "Coach Priya",
      niche: "coach",
      audience: "naye team leads",
      offers: "1:1 clarity call for ₹999",
      tone: "Energetic but kind",
      sound_answers: { greeting: "Hello dosto", phrases: "Simple si baat hai", never_say: "Hustle harder" },
      samples:
        "Simple si baat hai: delegate karna seekho, warna burnout pakka.\n\n---\n\nTeam ko har din ek clear goal do. Bas.\n\n---\n\nFeedback dena hai? Pehle sunna seekho.",
      banned_words: ["hustle", "grind"],
      language: "hinglish",
      profile_md: "Leadership coach for new team leads. Speaks Hinglish.",
      pillars: [{ name: "Mindset shifts", description: "Naye leads ke liye mindset shifts." }],
      words_per_second: 2.5,
      is_managed: false,
      autopilot_level: "review_everything",
    },
    post: {
      id: "91000000-0000-0000-0000-000000000003",
      title: "Sab kuch khud mat karo",
      hook: "Naye leads sabse pehle burnout kyun hote hain?",
      pillar: "Mindset shifts",
      format: "story",
    },
    dictionary: [{ written: "Priya", say_as: "pri-ya", status: "approved" }],
  },
  {
    key: "founder-en-uae",
    plan: "agency",
    brand: {
      id: "90000000-0000-0000-0000-000000000004",
      name: "Omar Builds",
      niche: "founder",
      audience: "first-time founders in Dubai",
      offers: "Founder office hours for AED 500",
      tone: "Direct, honest, a little dry",
      sound_answers: { greeting: "Hey founders", phrases: "Build in public", never_say: "Unicorn" },
      samples:
        "We ran out of cash twice. Both times, we had ignored the boring numbers.\n\n---\n\nHire slow. Fire kindly. Write it down.\n\n---\n\nBuild in public, but don't perform in public.",
      banned_words: ["unicorn", "disrupt"],
      language: "en",
      profile_md: "Second-time founder in Dubai sharing lessons from building a logistics start-up.",
      pillars: [{ name: "Lessons from failure", description: "What went wrong and what we learned." }],
      words_per_second: 2.3,
      is_managed: false,
      autopilot_level: "review_videos",
    },
    post: {
      id: "91000000-0000-0000-0000-000000000004",
      title: "The boring numbers that saved us",
      hook: "Which boring number almost killed my company?",
      pillar: "Lessons from failure",
      format: "talking",
    },
    dictionary: [],
  },
  {
    key: "business-story-roman-urdu",
    plan: "pro",
    brand: {
      id: "90000000-0000-0000-0000-000000000005",
      name: "Zee Lounge",
      niche: "business_story",
      audience: "Karachi ke khane ke shaukeen",
      offers: "Family dinner deal for Rs 3,499 at Zee Lounge",
      tone: "Garam joshi, ghar jaisa",
      sound_answers: { greeting: "Assalam o alaikum", phrases: "Humari kahani", never_say: "Cheap" },
      samples:
        "Humari kahani ek chhote se dhabay se shuru hui.\n\n---\n\nAmmi ki recipe aaj bhi wahi hai.\n\n---\n\nHar Jumme family table pehle se book karwa lein.",
      banned_words: ["cheap", "sasta"],
      language: "roman_urdu",
      profile_md: "Family restaurant in Karachi telling its story in Roman Urdu.",
      pillars: [{ name: "How it started", description: "Dhabay se restaurant tak ka safar." }],
      words_per_second: 2.5,
      is_managed: false,
      autopilot_level: "full_autopilot",
    },
    post: {
      id: "91000000-0000-0000-0000-000000000005",
      title: "Ammi ki recipe",
      hook: "Ek recipe ne humari zindagi kaise badal di?",
      pillar: "How it started",
      format: "story",
    },
    dictionary: [{ written: "Zee Lounge", say_as: "zee lounge", status: "approved" }],
  },
];
