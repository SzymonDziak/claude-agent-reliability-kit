import { reply, toolUse } from "../src/fakeClient.ts";

export const validClaim = {
  policy_number: "POL-48213", claimant_name: "Jordan Alvarez", incident_date: "2026-08-14", claim_type: "auto",
  amount_claimed: 3420.5, currency: "USD", coverage_confirmed: true, summary: "Rear-end collision.",
};
export const lookup = (id: string, policy = "POL-48213") => reply([toolUse(id, "lookup_policy", { policy_number: policy })]);
export const submit = (input: unknown, id = "tu_s") => reply([toolUse(id, "submit_claim", input)]);

/** Fake clock + sleep: sleeping just advances time, so backoff tests run instantly. */
export function fakeClock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps };
}
