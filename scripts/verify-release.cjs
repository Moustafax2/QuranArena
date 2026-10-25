const baseUrl = (process.argv[2] || "https://www.quranarena.ca").replace(/\/$/, "");

if (!/^https?:\/\//.test(baseUrl)) {
  throw new Error("Usage: node scripts/verify-release.cjs [https://host]");
}

async function request(path) {
  const response = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
  const body = await response.text();
  return { response, body };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const expectedPages = ["/privacy", "/terms", "/privacy/controls", "/credits"];
  for (const path of expectedPages) {
    const { response } = await request(path);
    assert(response.status === 200, `${path} returned ${response.status}, expected 200`);
    console.log(`ok ${response.status} ${path}`);
  }

  const { body: privacy } = await request("/privacy");
  assert(privacy.includes("Effective: October 25, 2026"), "Privacy effective date is missing");
  assert(privacy.includes("L4Z 4K4"), "Privacy postal code is missing");
  assert(!privacy.toLowerCase().includes("noindex"), "Privacy page is still noindex");
  assert(!privacy.includes("Draft for review"), "Privacy page still contains the draft banner");
  assert(privacy.includes("support@quranarena.ca"), "Privacy support email is missing");
  assert(!privacy.toLowerCase().includes("quranarena@protonmail.com"), "Privacy page still publishes the forwarding inbox");
  console.log("ok privacy publication metadata");

  const { response: consent } = await request("/api/privacy/consent");
  assert(consent.status === 200, `Consent endpoint returned ${consent.status}, expected 200`);
  assert(
    (consent.headers.get("cache-control") || "").toLowerCase().includes("no-store"),
    "Consent endpoint is missing Cache-Control: no-store"
  );
  console.log("ok privacy consent no-store");

  for (const path of ["/data/al-muyassar-fi-al-gharib.json", "/data/hanswehr.sqlite"]) {
    const { response } = await request(path);
    assert(response.status === 404, `${path} returned ${response.status}, expected 404`);
    console.log(`ok hidden ${path}`);
  }

  console.log(`Release smoke checks passed for ${baseUrl}`);
  console.log("Authentication, deletion, multiplayer isolation and Cron execution still require the manual acceptance plan.");
}

main().catch((error) => {
  console.error(`Release verification failed: ${error.message}`);
  process.exitCode = 1;
});
