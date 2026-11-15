/**
 * Shared, dependency-free helpers for the flashcard verification tests
 * (docs/flashcard-verification-plan.md §3.1): a seeded random generator, time
 * zone and fake-clock control, and a fake browser (localStorage plus a fetch
 * stub) that runs the real storage code as a guest or against an in-memory
 * server that answers like the /api/flashcards routes.
 */

import { getDayStart } from "@/lib/flashcard/queue";

// ── Seeded random numbers (mulberry32) ───────────────────────────────────────

export class Rng {
  private state: number;
  constructor(readonly seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [a, b]. */
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  float(a: number, b: number): number {
    return a + this.next() * (b - a);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
  /** Picks an index by weight. */
  weighted(weights: readonly number[]): number {
    const total = weights.reduce((a, b) => a + b, 0);
    let x = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      x -= weights[i];
      if (x < 0) return i;
    }
    return weights.length - 1;
  }
  /** A stable uuid-shaped id. */
  uuid(): string {
    const hex = () => this.int(0, 0xffff).toString(16).padStart(4, "0");
    return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-8${hex().slice(1)}-${hex()}${hex()}${hex()}`;
  }
}

export const SEEDS = {
  fsrs: 0xb2f50001,
  classic: 0xb2c10001,
  queue: 0xb2a00001,
  simulation: 0xb25d0090,
} as const;


// ── Time zones and study days ────────────────────────────────────────────────

export const DST_ZONES = ["America/New_York", "America/Toronto", "Europe/London", "Pacific/Auckland", "Australia/Lord_Howe"] as const;

/** Runs `fn` with Node's local time zone set to `tz` (TZ is read inside the process). */
export function withTimeZone<T>(tz: string, fn: () => T): T {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  const restore = () => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  };
  let result: T;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (result instanceof Promise) return result.finally(restore) as T;
  restore();
  return result;
}

/** The offset of `tz` at `date` in minutes east of UTC, from Intl (independent of TZ). */
export function intlOffsetMinutes(tz: string, date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The 4am study day of `date` in the current zone, as a whole-day number. */
export function studyDay(date: Date): number {
  const start = getDayStart(date);
  return Math.round(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate()) / DAY_MS);
}

/** `date` moved by `days` calendar days, keeping the local wall-clock time. */
export function addLocalDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// ── Fake clock ───────────────────────────────────────────────────────────────

export interface Clock {
  now(): number;
  set(date: Date | number): void;
  advance(ms: number): void;
}

const RealDate = Date;

/**
 * Replaces the global Date so that `new Date()` and `Date.now()` read a clock
 * the test moves. Dates built from arguments behave as usual. The real Date is
 * restored afterwards, also on failure.
 */
export async function withClock<T>(start: Date | number, fn: (clock: Clock) => Promise<T>): Promise<T> {
  let current = new RealDate(start).getTime();
  const clock: Clock = {
    now: () => current,
    set: (date) => { current = new RealDate(date).getTime(); },
    advance: (ms) => { current += ms; },
  };
  class FakeDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(current);
      else super(...(args as [string | number | Date]));
    }
    static now() {
      return current;
    }
  }
  globalThis.Date = FakeDate as DateConstructor;
  try {
    return await fn(clock);
  } finally {
    globalThis.Date = RealDate;
  }
}

// ── Fake browser and server ──────────────────────────────────────────────────

type Row = Record<string, unknown>;

/**
 * An in-memory stand-in for the /api/flashcards routes of one signed-in
 * player: the same orderings (cards by created_at then id, reviews newest
 * first then id, 500 per page), add-only POST by word, duplicate review ids
 * ignored, PATCH merging only the fields sent.
 */
export class FakeServer {
  cards: Row[] = [];
  reviews: Row[] = [];
  preferences: Row | null = null;
  requests = 0;

  handle(url: string, init?: RequestInit): Response {
    this.requests++;
    const method = init?.method ?? "GET";
    const u = new URL(url, "http://local.test");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = u.pathname;
    const ok = () => Response.json({ ok: true });

    if (path === "/api/flashcards/cards") {
      if (method === "GET") {
        const rows = [...this.cards].sort((a, b) =>
          String(a.created_at) < String(b.created_at) ? -1 : String(a.created_at) > String(b.created_at) ? 1 : String(a.id) < String(b.id) ? -1 : 1
        );
        return Response.json(rows);
      }
      const list = (Array.isArray(body) ? body : [body]) as Row[];
      if (method === "POST") {
        for (const card of list) {
          if (this.cards.some((c) => c.word_id === card.word_id)) continue;
          this.cards.push({ ...card, sm2_state: card.sm2_state ?? null });
        }
        return ok();
      }
      if (method === "PUT") {
        for (const card of list) {
          const existing = this.cards.find((c) => c.word_id === card.word_id);
          if (!existing) this.cards.push({ ...card, sm2_state: card.sm2_state ?? null });
          else Object.assign(existing, { ...card, id: existing.id, sm2_state: card.sm2_state ?? existing.sm2_state });
        }
        return ok();
      }
    }
    const cardMatch = path.match(/^\/api\/flashcards\/cards\/([^/]+)$/);
    if (cardMatch) {
      const id = decodeURIComponent(cardMatch[1]);
      if (method === "PATCH") {
        const card = this.cards.find((c) => c.id === id);
        if (card) Object.assign(card, body);
        return ok();
      }
      if (method === "DELETE") {
        this.cards = this.cards.filter((c) => c.id !== id);
        this.reviews = this.reviews.filter((r) => r.card_id !== id);
        return ok();
      }
    }
    if (path === "/api/flashcards/reviews") {
      if (method === "GET") {
        const start = u.searchParams.get("start_date");
        const limit = Math.min(Number(u.searchParams.get("limit") ?? 100), 500);
        const offset = Number(u.searchParams.get("offset") ?? 0);
        const rows = this.reviews
          .filter((r) => !start || String(r.timestamp) >= start)
          .sort((a, b) => (String(a.timestamp) > String(b.timestamp) ? -1 : String(a.timestamp) < String(b.timestamp) ? 1 : String(a.id) > String(b.id) ? -1 : 1));
        return Response.json(rows.slice(offset, offset + limit));
      }
      if (method === "POST") {
        for (const review of (Array.isArray(body) ? body : [body]) as Row[]) {
          if (this.reviews.some((r) => r.id === review.id)) continue;
          if (!this.cards.some((c) => c.id === review.card_id)) continue;
          this.reviews.push(review);
        }
        return ok();
      }
    }
    const reviewMatch = path.match(/^\/api\/flashcards\/reviews\/([^/]+)$/);
    if (reviewMatch && method === "DELETE") {
      this.reviews = this.reviews.filter((r) => r.id !== decodeURIComponent(reviewMatch[1]));
      return ok();
    }
    if (path === "/api/flashcards/preferences") {
      if (method === "GET") return Response.json(this.preferences);
      if (method === "PUT") {
        this.preferences = { ...(this.preferences ?? {}), ...body };
        return ok();
      }
    }
    return Response.json({ error: `fake server: no route for ${method} ${path}` }, { status: 404 });
  }
}

export interface FakeBrowser {
  store: Map<string, string>;
  server: FakeServer | null;
}

/**
 * Runs `fn` with a fake localStorage and fetch. Without a server every
 * /api/flashcards call answers 401, so the real storage code takes its guest
 * path; with one, it is a signed-in browser talking to `server`. Any other
 * URL fails the test: nothing here may reach the network.
 */
export async function withBrowser<T>(browser: FakeBrowser, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { window: g.window, localStorage: g.localStorage, fetch: globalThis.fetch };
  const { store } = browser;
  g.window = globalThis;
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("/api/flashcards/")) throw new Error(`blocked a request outside the fake server: ${url}`);
    if (!browser.server) return Response.json({ error: "Authentication required." }, { status: 401 });
    return browser.server.handle(url, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    g.window = saved.window;
    g.localStorage = saved.localStorage;
    globalThis.fetch = saved.fetch;
  }
}

export function newBrowser(signedIn: boolean): FakeBrowser {
  return { store: new Map(), server: signedIn ? new FakeServer() : null };
}

// ── Test output ──────────────────────────────────────────────────────────────

export function ok(name: string) {
  console.log(`ok - ${name}`);
}
