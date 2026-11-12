import { CONSENT_VERSION } from "./tokens";

export interface ConsentStatus {
  accepted: boolean;
  underage: boolean;
  signedIn: boolean;
  account: boolean;
}

export async function fetchConsentStatus(): Promise<ConsentStatus> {
  const response = await fetch("/api/privacy/consent", { cache: "no-store" });
  if (!response.ok) throw new Error("Privacy controls are temporarily unavailable. Please reload to try again.");
  const data = await response.json();
  return {
    accepted: Boolean(data.accepted),
    underage: Boolean(data.underage),
    signedIn: Boolean(data.signedIn),
    account: Boolean(data.account),
  };
}

// Records the single explicit, unticked religious-data opt-in. Continuing past
// the consent box also confirms age eligibility and acknowledges the linked
// Terms and Privacy Policy. Returns "underage" when the visitor said they are
// under 13 (the server then blocks study, game and sign-in features).
export async function saveConsent(eligible: boolean): Promise<"accepted" | "underage"> {
  const response = await fetch("/api/privacy/consent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(eligible
      ? { eligible: true, religiousData: true, noticeRead: true, version: CONSENT_VERSION }
      : { eligible: false }),
  });
  const data = await response.json().catch(() => ({}));
  if (!eligible && response.status === 403) return "underage";
  if (!response.ok) throw new Error(data.error ?? "Could not save your choice.");
  return "accepted";
}
