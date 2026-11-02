import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const ORIGINS = ["https://gestion.eugceo.fr", "https://eugceo.github.io"];
const SIGNATURE_IMG = "https://eugceo.fr/img/signature-mail.png";
function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
function linkify(s: string) {
  return s.replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" style="color:#111111">${u}</a>`);
}
function toHtml(text: string) {
  const body = linkify(esc(text)).replace(/\n/g, "<br>");
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff">
<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111111;max-width:600px">${body}</div>
<div style="margin-top:28px;max-width:560px"><a href="https://eugceo.fr"><img src="${SIGNATURE_IMG}" width="560" alt="EUGCEO · La Maison · 07 82 16 12 80 · contact@eugceo.fr · eugceo.fr" style="display:block;border:0;width:100%;max-width:560px;height:auto"></a></div>
</body></html>`;
}
const TEXT_SIG = "\n\n--\nEUGCEO · La Maison\n07 82 16 12 80 · contact@eugceo.fr · eugceo.fr\nRévèle le CEO qui est en toi";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "methode" }, 405);

  const auth = req.headers.get("Authorization") || "";
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const sb = createClient(url, anon, { global: { headers: { Authorization: auth } } });
  const { data: membre, error: e1 } = await sb.rpc("est_membre");
  if (e1 || membre !== true) return json(req, { error: "interdit" }, 403);

  let b: any;
  try { b = await req.json(); } catch { return json(req, { error: "invalide" }, 400); }
  const to = String(b?.to || "").trim();
  const subject = String(b?.subject || "").trim().slice(0, 200);
  const text = String(b?.text || "").slice(0, 10000);
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to) || !subject || text.trim().length < 2) return json(req, { error: "invalide" }, 400);

  // pièces jointes : PDF seulement, 2 au plus, 6 Mo au total (en base64)
  const atts = Array.isArray(b?.attachments) ? b.attachments.slice(0, 2) : [];
  const attachments: { filename: string; content: string }[] = [];
  let taille = 0;
  for (const a of atts) {
    const filename = String(a?.filename || "");
    const content = String(a?.content || "");
    if (!/^[\w.\-]{1,80}\.pdf$/i.test(filename) || !/^[A-Za-z0-9+/=]+$/.test(content)) return json(req, { error: "piece_jointe" }, 400);
    taille += content.length;
    attachments.push({ filename, content });
  }
  if (taille > 6_000_000) return json(req, { error: "piece_jointe_trop_lourde" }, 400);

  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return json(req, { error: "non_configure" });
  const from = Deno.env.get("MAIL_FROM") || "EUGCEO <contact@eugceo.fr>";

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from, to: [to], subject, text: text + TEXT_SIG, html: toHtml(text), reply_to: "contact@eugceo.fr",
      ...(attachments.length ? { attachments } : {}),
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error("resend", r.status, t.slice(0, 500));
    return json(req, { error: "envoi_refuse" }, 502);
  }
  const out = await r.json().catch(() => ({}));
  return json(req, { ok: true, id: out?.id || null });
});
