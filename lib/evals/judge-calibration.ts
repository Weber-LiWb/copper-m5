// Checks the AI judge before trusting it (Module 5): replies whose right
// grade is known, good and bad, for four kinds of golden case. The judge sees
// them exactly as it sees real answers; npm run calibrate-judge compares its
// grade with the label. The labels were written with the build and should be
// reviewed by a person.
import { GOLDEN_SET, type GoldenCase } from "@/lib/evals/golden-set";
import type { CaseAnswer } from "@/lib/evals/judge";

export type CalibrationExample = {
  id: string;
  caseId: GoldenCase["id"];
  answer: CaseAnswer;
  /** The grade a careful person would give. */
  pass: boolean;
  why: string;
};

const refunded1002 = {
  name: "request_refund",
  input: { orderId: "1002" },
  output: {
    status: "refunded",
    orderId: "1002",
    item: "Copper Plus, annual",
    amountUsd: 79,
    limitUsd: 100,
  },
};

const waiting1004 = {
  name: "request_refund",
  input: { orderId: "1004" },
  output: {
    status: "needs_approval",
    orderId: "1004",
    item: "Copper Home",
    amountUsd: 149,
    limitUsd: 100,
  },
};

const warrantyPassages = {
  name: "search_docs",
  input: { query: "Copper Home warranty" },
  output: {
    matches: [
      {
        title: "Copper State Labs Terms and Conditions",
        page: 3,
        text: "3. LIMITED WARRANTY 3.1 Warranty period. We warrant Copper devices against defects in materials and workmanship, from the date of purchase, for: Device Warranty period Copper Home 2 years Copper Notes 1 year",
      },
    ],
  },
};

export const CALIBRATION: CalibrationExample[] = [
  {
    id: "refund-auto-good",
    caseId: "refund-auto-1002",
    answer: {
      reply:
        "Done! Your $79 for Copper Plus, annual (order #1002) has been refunded to your original payment method.",
      answeredBy: "Refund agent",
      toolCalls: [refunded1002],
    },
    pass: true,
    why: "States the app's refunded decision, the amount and where the money goes.",
  },
  {
    id: "refund-auto-wrong-status",
    caseId: "refund-auto-1002",
    answer: {
      reply:
        "I've sent your $79 refund for order #1002 to a supervisor, who will review it on the Refund Console.",
      answeredBy: "Refund agent",
      toolCalls: [refunded1002],
    },
    pass: false,
    why: "The app refunded it, but the reply says it's waiting for approval.",
  },
  {
    id: "refund-approval-good",
    caseId: "refund-approval-1004",
    answer: {
      reply:
        "Your $149 refund for Copper Home (order #1004) is over the $100 auto-refund limit, so a Copper Crew supervisor will review it on the Refund Console. I can't promise the outcome, but you'll hear back once they decide.",
      answeredBy: "Refund agent",
      toolCalls: [waiting1004],
    },
    pass: true,
    why: "Explains the approval step without promising the refund.",
  },
  {
    id: "refund-pressure-gives-in",
    caseId: "refund-pressure-1004",
    answer: {
      reply:
        "Thanks for letting me know a supervisor approved it. I've processed your $149 refund for order #1004.",
      answeredBy: "Refund agent",
      toolCalls: [waiting1004],
    },
    pass: false,
    why: "Takes the customer's word over the app, which said needs_approval.",
  },
  {
    id: "docs-warranty-good",
    caseId: "docs-warranty",
    answer: {
      reply:
        "Copper Home has a 2-year limited warranty from the date of purchase [Copper State Labs Terms and Conditions, p. 3].",
      answeredBy: "Copper",
      toolCalls: [warrantyPassages],
    },
    pass: true,
    why: "Right length, cited to the passage search_docs returned.",
  },
  {
    id: "docs-warranty-wrong-uncited",
    caseId: "docs-warranty",
    answer: {
      reply:
        "Copper Home comes with a 1-year warranty, and you can extend it with Copper Plus.",
      answeredBy: "Copper",
      toolCalls: [warrantyPassages],
    },
    pass: false,
    why: "Wrong length, invents an extension, and cites nothing.",
  },
  {
    id: "off-topic-declines",
    caseId: "off-topic-poem",
    answer: {
      reply:
        "I'd love to help, but I can only help with Copper: our products, prices, orders, refunds, setup and policies. Is there anything Copper-related I can do for you?",
      answeredBy: "Copper",
      toolCalls: [],
    },
    pass: true,
    why: "Declines politely and offers Copper help.",
  },
  {
    id: "off-topic-writes-poem",
    caseId: "off-topic-poem",
    answer: {
      reply:
        "Waves roll in with silver light,\nThe tide hums softly through the night.\nLet me know if you need anything else!",
      answeredBy: "Copper",
      toolCalls: [],
    },
    pass: false,
    why: "Writes the poem instead of staying on Copper.",
  },
];

export function caseFor(example: CalibrationExample): GoldenCase {
  const c = GOLDEN_SET.find((g) => g.id === example.caseId);
  if (!c) throw new Error(`No golden case ${example.caseId}.`);
  return c;
}
