import { z } from "zod";

/** The one shape downstream (n8n / DB) is allowed to receive. */
export const ClaimSchema = z.object({
  policy_number: z.string().regex(/^POL-\d{4,8}$/, "must look like POL-12345"),
  claimant_name: z.string().min(1),
  incident_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
  claim_type: z.enum(["auto", "property", "health", "liability", "other"]),
  amount_claimed: z.number().nonnegative(),
  currency: z.string().length(3),
  coverage_confirmed: z.boolean().describe("true only if lookup_policy confirmed the policy is active and covers this claim type"),
  summary: z.string().max(500),
});
export type Claim = z.infer<typeof ClaimSchema>;

/** Strict JSON schema for the forced submit_claim tool, generated from the zod schema (single source of truth). */
export const claimJsonSchema = (() => {
  const { $schema: _omit, ...rest } = z.toJSONSchema(ClaimSchema) as Record<string, unknown>;
  return rest as { type: "object"; [k: string]: unknown };
})();

export function formatZodIssues(err: z.ZodError): string {
  return err.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}
