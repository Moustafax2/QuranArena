"use client";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";

// Vercel Web Analytics (cookieless page-view counts). Send only the page path:
// drop query strings and fragments (OAuth callbacks carry ?code=&state=) and
// collapse multiplayer room IDs so individual rooms are not recorded.
function redact(event: BeforeSendEvent): BeforeSendEvent {
  const url = new URL(event.url);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/^\/play\/[^/]+/, "/play/[roomId]");
  return { ...event, url: url.toString() };
}

export function SiteAnalytics() {
  return <Analytics beforeSend={redact} />;
}
