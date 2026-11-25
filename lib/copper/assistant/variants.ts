// Module 5: Ask Copper as two agents (Copper hands refunds to the Refund
// agent) or as one Support agent with every tool. The app uses the two
// agents; the eval runs either one on the same golden set to compare them.

export const VARIANTS = ["multi", "single"] as const;

export type Variant = (typeof VARIANTS)[number];

export const DEFAULT_VARIANT: Variant = "multi";

export const VARIANT_LABELS: Record<Variant, string> = {
  multi: "multi-agent (Copper + Refund agent)",
  single: "single agent (Support agent)",
};

/** Reads a variant name ("multi" or "single"); empty means the default. */
export function parseVariant(value: string | undefined): Variant {
  const name = value?.trim().toLowerCase();
  if (!name) return DEFAULT_VARIANT;
  const variant = VARIANTS.find((v) => v === name);
  if (!variant)
    throw new Error(
      `Unknown variant "${value}": use ${VARIANTS.map((v) => `"${v}"`).join(" or ")}.`,
    );
  return variant;
}
