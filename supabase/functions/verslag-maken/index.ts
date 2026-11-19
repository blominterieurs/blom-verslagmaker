// Verslag maken: stuurt de prompt van de Blom Verslagmaker door naar Claude (Anthropic API)
// en geeft het antwoord direct, stukje voor stukje, terug aan de browser.
//
// - Alleen voor ingelogde collega's met een @blominterieurs.nl account.
// - Er wordt niets bewaard: geen database, geen opslag, en de inhoud wordt niet gelogd.
// - Kosten: er staan geen vaste prijzen in deze code. De prijs per token komt live uit de officiële
//   prijslijst van Anthropic, de dollarkoers live van de Europese Centrale Bank. Beide worden een paar uur
//   onthouden. Lukt het ophalen niet, dan meldt de app dat de kosten onbekend zijn.
// - Benodigde secret: ANTHROPIC_API_KEY. Optioneel: ANTHROPIC_MODEL en TOEGESTANE_ORIGINS
//   (komma gescheiden, standaard https://blominterieurs.github.io).
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const DOMEIN = /@blominterieurs\.nl$/i;
const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5";
const ORIGINS = (Deno.env.get("TOEGESTANE_ORIGINS") || "https://blominterieurs.github.io")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MAX_PROMPT = 70_000;          // tekens
const MAX_AFBEELDING = 6_000_000;   // base64 tekens, ruim 4 MB
const PRIJSLIJST = "https://platform.claude.com/docs/en/about-claude/pricing.md";
const ECB = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const ONTHOUD_MS = 6 * 60 * 60 * 1000;

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
const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
const fout = (req: Request, status: number, melding: string) => json(req, status, { error: melding });

/* ---------- actuele prijs ---------- */
type Prijs = { model: string; naam: string; invoerUsdPerMiljoen: number; uitvoerUsdPerMiljoen: number; koersUsdEur: number; koersDatum: string; opgehaald: string } | null;
let prijsCache: { tot: number; waarde: Prijs } = { tot: 0, waarde: null };

// claude-sonnet-5-5 -> "Claude Sonnet 5.5"
function modelNaam(id: string) {
  const delen = id.replace(/-\d{8}$/, "").split("-");
  if (delen[0] !== "claude") return id;
  const familie = delen.find((d) => /^[a-z]+$/.test(d) && d !== "claude") || "";
  const versie = delen.filter((d) => /^\d+$/.test(d)).join(".");
  return `Claude ${familie.charAt(0).toUpperCase() + familie.slice(1)} ${versie}`.trim();
}
const dollar = (cel: string) => { const m = cel.match(/\$\s*([\d.,]+)/); return m ? Number(m[1].replace(",", "")) : NaN; };

async function prijsOphalen(): Promise<Prijs> {
  if (Date.now() < prijsCache.tot) return prijsCache.waarde;
  let waarde: Prijs = null;
  try {
    const [lijst, koersXml] = await Promise.all([
      fetch(PRIJSLIJST, { headers: { "accept": "text/markdown, text/plain" } }).then((r) => r.ok ? r.text() : ""),
      fetch(ECB).then((r) => r.ok ? r.text() : ""),
    ]);
    const naam = modelNaam(MODEL);
    // eerste tabelrij die met de modelnaam begint: | Model | Base Input | ... | Output |
    const rij = lijst.split("\n").map((l) => l.trim())
      .find((l) => l.startsWith("|") && l.split("|")[1]?.trim().toLowerCase() === naam.toLowerCase());
    const cellen = rij ? rij.split("|").slice(1, -1).map((c) => c.trim()) : [];
    const invoer = cellen.length > 2 ? dollar(cellen[1]) : NaN;
    const uitvoer = cellen.length > 2 ? dollar(cellen[cellen.length - 1]) : NaN;
    const usd = koersXml.match(/currency=['"]USD['"]\s+rate=['"]([\d.]+)['"]/);
    const datum = koersXml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/);
    // ECB geeft euro -> dollar; omrekenen naar dollar -> euro
    const koers = usd ? 1 / Number(usd[1]) : NaN;
    if (Number.isFinite(invoer) && Number.isFinite(uitvoer) && Number.isFinite(koers)) {
      waarde = { model: MODEL, naam, invoerUsdPerMiljoen: invoer, uitvoerUsdPerMiljoen: uitvoer, koersUsdEur: koers, koersDatum: datum ? datum[1] : "", opgehaald: new Date().toISOString() };
    } else console.error("Prijs niet gevonden", { model: naam, rij: !!rij, koers: !!usd });
  } catch (e) { console.error("Prijs ophalen mislukt", (e as Error)?.message || e); }
  // gelukt: een paar uur onthouden; mislukt: over tien minuten opnieuw proberen
  prijsCache = { tot: Date.now() + (waarde ? ONTHOUD_MS : 10 * 60 * 1000), waarde };
  return waarde;
}
const kostenEur = (p: Prijs, inv: number, uit: number) =>
  p ? (inv * p.invoerUsdPerMiljoen + uit * p.uitvoerUsdPerMiljoen) / 1_000_000 * p.koersUsdEur : null;

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

  let inv: { actie?: string; prompt?: string; image?: { type?: string; base64?: string } };
  try { inv = await req.json(); } catch { return fout(req, 400, "Ongeldige aanvraag."); }

  // 2. alleen de actuele prijs opvragen (voor de schatting vooraf)
  if (inv.actie === "prijs") return json(req, 200, { prijs: await prijsOphalen() });

  // 3. de vraag
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
  const prijsBelofte = prijsOphalen();

  // 4. Claude aanroepen met streaming
  const antwoord = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": sleutel, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 16000, stream: true, messages: [{ role: "user", content: inhoud }] }),
    signal: req.signal,
  });
  if (!antwoord.ok || !antwoord.body) {
    const status = antwoord.status === 429 || antwoord.status === 529 ? 429 : 502;
    console.error("Anthropic fout", antwoord.status);   // alleen de status, nooit de inhoud
    return fout(req, status, status === 429 ? "Claude is even druk of het maandbudget is bereikt. Probeer het later opnieuw." : "Claude gaf een fout.");
  }

  // 5. alleen de tekst doorgeven, als platte tekst stream; aan het eind een regel met de werkelijke kosten
  const enc = new TextEncoder(), dec = new TextDecoder();
  let buffer = "", invoer = 0, uitvoer = 0, uitTekens = 0;
  const stroom = new ReadableStream({
    async start(ctrl) {
      const stuur = (t: string) => { try { ctrl.enqueue(enc.encode(t)); } catch { /* browser is weg */ } };
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
              if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") { uitTekens += ev.delta.text.length; stuur(ev.delta.text); }
              else if (ev.type === "message_start") invoer = ev.message?.usage?.input_tokens || 0;
              else if (ev.type === "message_delta" && ev.usage?.output_tokens) uitvoer = ev.usage.output_tokens;
              else if (ev.type === "error") stuur('\n{"type":"fout"}\n');
            } catch { /* onvolledige regel overslaan */ }
          }
        }
      } catch {
        stuur('\n{"type":"fout"}\n');
      } finally {
        // ook bij afbreken rekent Anthropic de al geschreven tokens; schat die als het eindtotaal ontbreekt
        const geschat = !uitvoer && uitTekens > 0;
        if (geschat) uitvoer = Math.ceil(uitTekens / 3.5);
        const prijs = await prijsBelofte.catch(() => null);
        const eur = kostenEur(prijs, invoer, uitvoer);
        stuur("\n" + JSON.stringify({ type: "kosten", invoer, uitvoer, geschat, eur: eur == null ? null : Math.round(eur * 10000) / 10000, prijs }) + "\n");
        try { ctrl.close(); } catch { /* al gesloten */ }
      }
    },
  });
  return new Response(stroom, { headers: { ...cors(req), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
});
