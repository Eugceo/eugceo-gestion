import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const num = (v: unknown) => {
  const x = Number(String(v ?? "").replace(",", "."));
  return isFinite(x) ? x : 0;
};
const r2 = (x: number) => Math.round(x * 100) / 100;
const eur = (x: number) => x.toFixed(2).replace(".", ",") + " €";
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(
    new Date(),
  );
const PAYS: Record<string, string> = {
  FR: "France métropolitaine",
  GP: "Guadeloupe",
  MQ: "Martinique",
  GF: "Guyane",
  RE: "La Réunion",
  YT: "Mayotte",
};

async function hmacHex(secret: string, msg: string) {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    k,
    new TextEncoder().encode(msg),
  );
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function eq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function verify(raw: string, header: string, secret: string) {
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=") as [string, string]).filter((p) =>
      p.length === 2
    ),
  ) as any;
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) =>
    p.slice(3)
  );
  const t = parts.t;
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;
  const exp = await hmacHex(secret, `${t}.${raw}`);
  return sigs.some((s) => eq(s, exp));
}
const esc = (s: string) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (
      c,
    ) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]!),
  );
async function mail(to: string, subject: string, text: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key || !to) return;
  const html =
    `<!doctype html><html><body style="margin:0;padding:24px;background:#fff"><div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111;max-width:600px">${
      esc(text).replace(/\n/g, "<br>")
    }</div><div style="margin-top:28px;max-width:560px"><a href="https://eugceo.fr"><img src="https://eugceo.fr/img/signature-mail.png" width="560" alt="EUGCEO · La Maison · 07 82 16 12 80 · contact@eugceo.fr · eugceo.fr" style="display:block;border:0;width:100%;max-width:560px;height:auto"></a></div></body></html>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "EUGCEO <contact@eugceo.fr>",
      to: [to],
      subject,
      text: text +
        "\n\n--\nEUGCEO · La Maison\n07 82 16 12 80 · contact@eugceo.fr · eugceo.fr",
      html,
      reply_to: "contact@eugceo.fr",
    }),
  });
  if (!r.ok) console.error("mail", r.status, (await r.text()).slice(0, 300));
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("ok");
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const raw = await req.text();
  if (
    !secret ||
    !(await verify(raw, req.headers.get("stripe-signature") || "", secret))
  ) return new Response("signature", { status: 400 });
  const ev = JSON.parse(raw);
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  const s = ev.data?.object || {};
  const { data: row } = await admin.from("paiements").select("id,data").eq(
    "id",
    s.id || "",
  ).maybeSingle();
  if (!row) return new Response("inconnu");
  const P: any = row.data;

  if (
    ev.type === "checkout.session.expired" ||
    ev.type === "checkout.session.async_payment_failed"
  ) {
    await admin.from("reservations").update({ statut: "expiree" }).eq(
      "session_id",
      s.id,
    ).eq("statut", "active");
    if (P.statut === "en_attente") {
      await admin.from("paiements").update({
        data: {
          ...P,
          statut: ev.type.endsWith("failed") ? "échoué" : "expiré",
        },
        updated_at: new Date().toISOString(),
      }).eq("id", s.id);
    }
    return new Response("ok");
  }
  const paid =
    (ev.type === "checkout.session.completed" && s.payment_status === "paid") ||
    ev.type === "checkout.session.async_payment_succeeded";
  if (!paid) return new Response("ok");
  if (P.statut === "payé") return new Response("deja");
  // verrou : on marque d'abord comme payé (évite un double traitement)
  const { data: lock } = await admin.from("paiements").update({
    data: {
      ...P,
      statut: "payé",
      payeLe: new Date().toISOString(),
      montantRecu: r2(num(s.amount_total) / 100),
    },
    updated_at: new Date().toISOString(),
  }).eq("id", s.id).eq("data->>statut", "en_attente").select("id");
  if (!lock || !lock.length) return new Response("deja");

  const cd = s.customer_details || {};
  const ship = s.collected_information?.shipping_details ||
    s.shipping_details || null;
  const nom = (P.test ? "[TEST] " : "") +
    (P.client?.nom || cd.name || "Cliente");
  const email = P.client?.email || cd.email || "";
  const tel = cd.phone || P.client?.telephone || "";
  const now = new Date().toISOString(), d0 = today();
  const prenom = String(P.client?.nom || cd.name || "").split(" ")[0];

  if (P.type === "commande") {
    const a = ship?.address || {};
    const adresse = P.livraison === "retrait"
      ? "Retrait sur rendez-vous"
      : [ship?.name && ship.name !== nom ? ship.name : "", a.line1, a.line2]
        .filter(Boolean).join(", ");
    const ville = P.livraison === "retrait"
      ? ""
      : [a.postal_code, a.city].filter(Boolean).join(" ");
    const destination = P.livraison === "retrait"
      ? "France métropolitaine"
      : (PAYS[a.country] || "France métropolitaine");
    const y = d0.slice(0, 4);
    const { data: nums } = await admin.from("ventes").select("data->>numero")
      .like("data->>numero", `EC-${y}-%`);
    let max = 0;
    for (const n of (nums || []) as any[]) {
      const m = String(n.numero || "").match(/^EC-\d{4}-(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    }
    const ventes: any[] = [];
    const ids: string[] = [];
    P.details.forEach((d: any, i: number) => {
      const port = i === 0 ? num(P.port) : 0;
      const stock = d.mode === "stock";
      const id = crypto.randomUUID();
      ids.push(id);
      ventes.push({
        id,
        data: {
          date: d0,
          client: nom,
          email,
          telephone: tel,
          produitId: d.id,
          designation: d.titre,
          quantite: d.qte,
          prixTTC: num(d.prixInitial) || d.prix,
          remise: r2(((num(d.prixInitial) || d.prix) - d.prix) * d.qte),
          ...(P.promo?.type === "parrainage" ? { codePromo: P.promo.code } : {}),
          ...(P.promo?.type === "cagnotte"
            ? {
              cagnotteCode: P.promo.code,
              cagnotteLe: d0,
              cagnottePct: P.promo.pct,
            }
            : {}),
          port,
          packaging: "Standard",
          statut: stock ? "Payée" : "En attente de paiement",
          paiement: "Carte bancaire",
          dateEncaissement: stock ? d0 : "",
          avanceType: stock ? "Aucune" : "Acompte",
          avanceMontant: stock ? "" : r2(d.paye + port),
          avanceDate: stock ? "" : d0,
          adresse,
          ville,
          destination,
          commentaire: `Commande en ligne (Stripe ${s.id.slice(-8)})${
            stock ? "" : " · création sur commande, acompte payé"
          }${
            P.promo
              ? P.promo.type === "cagnotte"
                ? ` · cagnotte ${P.promo.pct} % utilisée`
                : ` · code ${P.promo.code} −${P.promo.pct} %`
              : ""
          }`,
          numero: `EC-${y}-${String(++max).padStart(3, "0")}`,
          origine: "site",
          paiementId: s.id,
          creeLe: now,
          modifieLe: now,
          excel: "nouveau",
        },
      });
    });
    await admin.from("ventes").insert(ventes);
    // code de parrainage de la cliente (créé d'office s'il n'existe pas)
    let codeCliente = "";
    try {
      const { data: cc } = await admin.rpc("code_cliente", {
        p_nom: P.client?.nom || cd.name || "",
        p_email: email,
        p_tel: tel,
      });
      codeCliente = cc || "";
    } catch (e) {
      console.error("code", String(e));
    }
    await admin.from("reservations").update({ statut: "payee" }).eq(
      "session_id",
      s.id,
    );
    const recap = P.details.map((d: any) =>
      `- ${d.titre}${d.qte > 1 ? " × " + d.qte : ""} : ${
        d.mode === "stock"
          ? eur(d.paye)
          : "acompte " + eur(d.paye) + " (prix " + eur(d.prix * d.qte) +
            ", solde avant l'expédition)"
      }`
    ).join("\n") + (P.promo
      ? P.promo.type === "cagnotte"
        ? `\nCagnotte utilisée : ${P.promo.pct} % (−${eur(num(P.promo.montant))})`
        : `\nCode ${P.promo.code} : −${P.promo.pct} % (−${eur(num(P.promo.montant))})`
      : "");
    let RP: any = {};
    try {
      RP = (await admin.rpc("parrainage_reglages")).data || {};
    } catch (_) { /* valeurs par défaut */ }
    const parrainTxt = codeCliente
      ? `\n\nVotre code de parrainage : ${codeCliente}\nOffrez-le à vos proches : elles ont −${num(RP.pct) || 10} % sur leur commande (à partir de ${num(RP.min) || 150} €), et vous gagnez ${num(RP.pct) || 10} % de cagnotte pour chaque commande passée avec votre code, jusqu'à une création offerte. Votre cagnotte s'utilise quand vous voulez, sur eugceo.fr.`
      : "";
    const livTxt = P.livraison === "retrait"
      ? "Retrait sur rendez-vous : nous vous contactons pour fixer le créneau."
      : `Livraison : ${
        eur(num(P.port))
      }\nAdresse : ${adresse}, ${ville} (${destination})`;
    await admin.from("paiements").update({
      data: {
        ...P,
        statut: "payé",
        payeLe: now,
        montantRecu: r2(num(s.amount_total) / 100),
        venteIds: ids,
        codeCliente,
      },
      updated_at: now,
    }).eq("id", s.id);
    await admin.from("demandes").insert({
      id: crypto.randomUUID(),
      data: {
        type: "paiement",
        nom,
        email,
        telephone: tel,
        statut: "Nouvelle",
        envoyeLe: now,
        paiementId: s.id,
        montant: r2(num(s.amount_total) / 100),
        message: `Commande payée en ligne : ${
          eur(num(s.amount_total) / 100)
        }\n${recap}\n${livTxt}`,
      },
    });
    await mail(
      email,
      "EUGCEO · Merci pour votre commande",
      `Bonjour ${prenom},\n\nMerci pour votre commande, votre paiement de ${
        eur(num(s.amount_total) / 100)
      } est bien reçu.\n\n${recap}\n\n${livTxt}\n\nLes créations disponibles sont expédiées sous 48 heures ouvrées. Les créations sur commande sont préparées en 15 à 30 jours ; nous vous enverrons le lien pour régler le solde avant l'expédition.${parrainTxt}\n\nÀ très vite,\nEUGCEO`,
    );
    await mail(
      "contact@eugceo.fr",
      `Nouvelle commande en ligne · ${nom} · ${eur(num(s.amount_total) / 100)}`,
      `Commande payée par ${nom} (${email}${
        tel ? ", " + tel : ""
      }).\n\n${recap}\n\n${livTxt}\n\nLes ventes sont créées dans l'app (Ventes), la commande apparaît aussi dans Demandes reçues.`,
    );
    return new Response("ok");
  }
  if (P.type === "devis") {
    const { data: dv } = await admin.from("devis").select("id,data").eq(
      "id",
      P.devisId,
    ).maybeSingle();
    if (dv) {
      await admin.from("devis").update({
        data: {
          ...dv.data,
          acomptePaye: { montant: P.total, le: now, paiementId: s.id },
        },
        updated_at: now,
      }).eq("id", dv.id);
    }
    await admin.from("demandes").insert({
      id: crypto.randomUUID(),
      data: {
        type: "paiement",
        nom,
        email,
        telephone: tel,
        statut: "Nouvelle",
        envoyeLe: now,
        paiementId: s.id,
        devisId: P.devisId,
        montant: P.total,
        message: `Acompte du devis ${P.numero} payé en ligne : ${eur(P.total)}`,
      },
    });
    await mail(
      email,
      `EUGCEO · Acompte reçu pour le devis ${P.numero}`,
      `Bonjour ${prenom},\n\nNous avons bien reçu votre acompte de ${
        eur(P.total)
      } pour le devis ${P.numero}. Votre création est lancée : nous revenons vers vous très vite.\n\nÀ très vite,\nEUGCEO`,
    );
    await mail(
      "contact@eugceo.fr",
      `Acompte payé · devis ${P.numero} · ${eur(P.total)}`,
      `${nom} a payé l'acompte du devis ${P.numero} (${
        eur(P.total)
      }).\nPense à créer la vente depuis le devis dans l'app.`,
    );
    return new Response("ok");
  }
  if (P.type === "solde") {
    const { data: v } = await admin.from("ventes").select("id,data").eq(
      "id",
      P.venteId,
    ).maybeSingle();
    if (v) {
      await admin.from("ventes").update({
        data: {
          ...v.data,
          statut: "Payée",
          dateEncaissement: d0,
          paiement: "Carte bancaire",
          modifieLe: now,
          soldePaiementId: s.id,
        },
        updated_at: now,
      }).eq("id", v.id);
    }
    await admin.from("demandes").insert({
      id: crypto.randomUUID(),
      data: {
        type: "paiement",
        nom,
        email,
        telephone: tel,
        statut: "Nouvelle",
        envoyeLe: now,
        paiementId: s.id,
        montant: P.total,
        message: `Solde payé en ligne : ${eur(P.total)}${
          P.numero ? " (facture " + P.numero + ")" : ""
        }. La création peut être expédiée.`,
      },
    });
    await mail(
      email,
      "EUGCEO · Solde reçu",
      `Bonjour ${prenom},\n\nNous avons bien reçu le solde de ${
        eur(P.total)
      }. Votre création part très vite, nous vous envoyons le suivi dès l'expédition.\n\nÀ très vite,\nEUGCEO`,
    );
    await mail(
      "contact@eugceo.fr",
      `Solde payé · ${nom} · ${eur(P.total)}`,
      `${nom} a payé le solde (${eur(P.total)})${
        P.numero ? ", facture " + P.numero : ""
      }. La vente est passée en « Payée » : la création peut partir.`,
    );
    return new Response("ok");
  }
  return new Response("ok");
});
