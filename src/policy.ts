/** Fake policy-lookup "API" backed by in-memory sample data. Stands in for a slow/rate-limited internal service. */
export interface Policy {
  policy_number: string;
  holder: string;
  status: "active" | "lapsed";
  covers: string[];
  deductible: number;
  limit: number;
  notes: string;
}

const POLICIES: Policy[] = [
  { policy_number: "POL-48213", holder: "J. Alvarez", status: "active", covers: ["auto", "liability"], deductible: 500, limit: 25000, notes: "Standard auto package." },
  { policy_number: "POL-77102", holder: "M. Okafor", status: "active", covers: ["property"], deductible: 1000, limit: 150000, notes: "Homeowner policy, water damage rider included." },
  { policy_number: "POL-30955", holder: "T. Lindqvist", status: "lapsed", covers: ["auto"], deductible: 750, limit: 15000, notes: "Lapsed 2026-02-01 for non-payment." },
  { policy_number: "POL-91560", holder: "R. Petrov", status: "active", covers: ["health"], deductible: 250, limit: 50000, notes: "Supplemental health plan." },
];

export const lookupCalls = { count: 0 }; // lets tests/demo see how many real "API" hits happened

export function lookupPolicy(policyNumber: string): Policy {
  lookupCalls.count++;
  const p = POLICIES.find((x) => x.policy_number === policyNumber);
  if (!p) throw new Error(`Policy ${policyNumber} not found`);
  return p;
}
