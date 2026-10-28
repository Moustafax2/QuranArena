// Edge functions use an admin client, so a publishable/anon API key is never
// sufficient authorization. Only the Next.js server knows this shared secret.
export async function requireAppServer(request: Request): Promise<Response | null> {
  const expected = Deno.env.get("MULTIPLAYER_SERVER_SECRET");
  const supplied = request.headers.get("x-quranarena-server-secret");
  if (!expected || expected.length < 32 || !supplied) {
    return new Response(JSON.stringify({ error: "Server authorization required." }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(expected), digest(supplied)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0 ? null : new Response(JSON.stringify({ error: "Server authorization required." }), { status: 401, headers: { "Content-Type": "application/json" } });
}
