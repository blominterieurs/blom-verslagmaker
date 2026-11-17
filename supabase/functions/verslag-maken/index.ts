// Verslag maken: stuurt de prompt van de Blom Verslagmaker door naar Claude (Anthropic API)
// en geeft het antwoord direct, stukje voor stukje, terug aan de browser.
//
// - Alleen voor ingelogde collega's met een @blominterieurs.nl account.
// - Er wordt niets bewaard: geen database, geen opslag, en de inhoud wordt niet gelogd.
// - Benodigde secret: ANTHROPIC_API_KEY. Optioneel: ANTHROPIC_MODEL en TOEGESTANE_ORIGINS
//   (komma gescheiden, standaard https://blominterieurs.github.io).
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const DOMEIN = /@blominterieurs\.nl$/i;
const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5";
const ORIGINS = (Deno.env.get("TOEGESTANE_ORIGINS") || "https://blominterieurs.github.io")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MAX_PROMPT = 70_000;          // tekens
const MAX_AFBEELDING = 6_000_000;   // base64 tekens, ruim 4 MB

function cors(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const toegestaan = ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    "Access-Control-Allow-Origin": toegestaan ? origin : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const fout = (req: Request, status: number, melding: string) =>
  new Response(JSON.stringify({ error: melding }), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return fout(req, 405, "Alleen POST.");

  // 1. wie vraagt het?
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return fout(req, 401, "Niet ingelogd.");
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: wie, error: wieFout } = await supa.auth.getUser(token);
  if (wieFout || !wie?.user?.email) return fout(req, 401, "Niet ingelogd.");
  if (!DOMEIN.test(wie.user.email)) return fout(req, 403, "Alleen voor Blom-accounts.");

  // 2. de vraag
  let inv: { prompt?: string; image?: { type?: string; base64?: string } };
  try { inv = await req.json(); } catch { return fout(req, 400, "Ongeldige aanvraag."); }
  const prompt = String(inv.prompt || "");
  if (!prompt.trim()) return fout(req, 400, "Lege aanvraag.");
  if (prompt.length > MAX_PROMPT) return fout(req, 413, "De tekst is te lang.");
  const inhoud: unknown[] = [];
  if (inv.image?.base64) {
    const type = String(inv.image.type || "image/png");
    if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) return fout(req, 400, "Dit soort afbeelding wordt niet ondersteund.");
    if (inv.image.base64.length > MAX_AFBEELDING) return fout(req, 413, "De afbeelding is te groot.");
    inhoud.push({ type: "image", source: { type: "base64", media_type: type, data: inv.image.base64 } });
  }
  inhoud.push({ type: "text", text: prompt });

  const sleutel = Deno.env.get("ANTHROPIC_API_KEY");
  if (!sleutel) return fout(req, 500, "De koppeling met Claude is nog niet ingesteld.");

  // 3. Claude aanroepen met streaming
  const antwoord = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": sleutel, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 16000, stream: true, messages: [{ role: "user", content: inhoud }] }),
    signal: req.signal,
  });
  if (!antwoord.ok || !antwoord.body) {
    const status = antwoord.status === 429 || antwoord.status === 529 ? 429 : 502;
    console.error("Anthropic fout", antwoord.status);   // alleen de status, nooit de inhoud
    return fout(req, status, status === 429 ? "Claude is even druk. Probeer het zo opnieuw." : "Claude gaf een fout.");
  }

  // 4. alleen de tekst doorgeven, als platte tekst stream
  const enc = new TextEncoder(), dec = new TextDecoder();
  let buffer = "";
  const stroom = new ReadableStream({
    async start(ctrl) {
      const lezer = antwoord.body!.getReader();
      try {
        while (true) {
          const { done, value } = await lezer.read();
          if (done) break;
          buffer += dec.decode(value, { stream: true });
          let i;
          while ((i = buffer.indexOf("\n")) >= 0) {
            const regel = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
            if (!regel.startsWith("data:")) continue;
            try {
              const ev = JSON.parse(regel.slice(5));
              if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") ctrl.enqueue(enc.encode(ev.delta.text));
              else if (ev.type === "error") ctrl.enqueue(enc.encode('\n{"type":"fout"}\n'));
            } catch { /* onvolledige regel overslaan */ }
          }
        }
      } catch {
        ctrl.enqueue(enc.encode('\n{"type":"fout"}\n'));
      } finally {
        ctrl.close();
      }
    },
  });
  return new Response(stroom, { headers: { ...cors(req), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
});
