import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const ORIGINS = [
  "https://eugceo.fr",
  "https://www.eugceo.fr",
  "https://gestion.eugceo.fr",
  "https://eugceo.github.io",
];
const SITE = "https://eugceo.fr";
function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
const json = (req: Request, b: unknown, s = 200) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors(req), "Content-Type": "application/json" },
  });
const num = (v: unknown) => {
  const x = Number(String(v ?? "").replace(",", "."));
  return isFinite(x) ? x : 0;
};
const r2 = (x: number) => Math.round(x * 100) / 100;
const cents = (x: number) => Math.round(x * 100);
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
function titre(p: any) {
  const s = p.site || {};
  if (s.titre) return String(s.titre);
  return [
    p.modele,
    p.longueur ? p.longueur + "″" : "",
    p.couleur && p.couleur !== "Noir Naturel" ? p.couleur : "",
  ].filter(Boolean).join(" · ") || "Création EUGCEO";
}
function form(obj: any, prefix = "", out: string[] = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out);
    else {out.push(
        encodeURIComponent(key) + "=" + encodeURIComponent(String(v)),
      );}
  }
  return out.join("&");
}
async function stripeSession(params: any) {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("non_configure");
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form(params),
  });
  const j = await r.json();
  if (!r.ok) {
    console.error("stripe", r.status, JSON.stringify(j).slice(0, 600));
    throw new Error("stripe");
  }
  return j;
}
const DOM = ["GP", "MQ", "GF", "RE", "YT"];
const fr = (x: number) => x.toFixed(2).replace(".", ",");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors(req) });
  }
  if (req.method !== "POST") return json(req, { error: "methode" }, 405);
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  let b: any;
  try {
    b = await req.json();
  } catch {
    return json(req, { error: "invalide" }, 400);
  }
  if (!Deno.env.get("STRIPE_SECRET_KEY")) {
    return json(req, { error: "non_configure" });
  }
  const now = Math.floor(Date.now() / 1000);
  const expires = now + 31 * 60;
  try {
    /* ---------- commande depuis le panier ---------- */
    if (b?.type === "commande") {
      const { data: ouvert } = await admin.rpc("site_ouvert");
      if (ouvert !== true) {
        const { data: ap } = await admin.rpc("apercu_ok", {
          p_code: String(b.apercu || ""),
        });
        if (ap !== true) return json(req, { error: "ferme" }, 409);
      }
      const c = b.client || {};
      const nom = String(c.nom || "").trim().slice(0, 120),
        email = String(c.email || "").trim().slice(0, 200),
        tel = String(c.telephone || "").trim().slice(0, 40);
      if (nom.length < 2 || !EMAIL.test(email)) {
        return json(req, { error: "client" }, 400);
      }
      if (b.cgv !== true) return json(req, { error: "cgv" }, 400);
      const liv = ["fr", "dom", "retrait"].includes(b.livraison)
        ? b.livraison
        : null;
      if (!liv) return json(req, { error: "livraison" }, 400);
      const items = Array.isArray(b.items) ? b.items.slice(0, 10) : [];
      if (!items.length) return json(req, { error: "panier_vide" }, 400);
      const { data: cat, error: e1 } = await admin.rpc("catalogue_interne");
      if (e1) throw e1;
      const { data: R } = await admin.rpc("reglages_boutique");
      const pct = num(R?.acomptePct) || 40;
      const byId = new Map((cat || []).map((p: any) => [p.id, p]));
      // 1) lignes au prix plein
      const base: any[] = [];
      for (const it of items) {
        const p: any = byId.get(String(it.id));
        const qte = Math.max(1, Math.min(5, Math.floor(num(it.qte)) || 1));
        if (!p) return json(req, { error: "indisponible", id: it.id }, 409);
        const prix = num(p.site?.prix);
        if (!(prix > 0)) return json(req, { error: "prix", id: it.id }, 409);
        base.push({ p, qte, prix });
      }
      const sousTotal = r2(base.reduce((s, x) => s + x.prix * x.qte, 0));
      // 2) code d'ambassadrice ou cagnotte (pas de cumul), jamais sous le prix plancher
      const { data: pl } = await admin.from("produits").select(
        "id, plancher:data->>plancherSite",
      ).in("id", base.map((x) => x.p.id));
      const plancher = new Map((pl || []).map((r: any) => [r.id, num(r.plancher)]));
      // marge disponible par ligne (sans plancher connu : 50 % du prix au plus)
      const room = base.map((x) => {
        const f = plancher.get(x.p.id) || x.prix * 0.5;
        return Math.max(0, r2((x.prix - f) * x.qte));
      });
      // remise automatique par lot de bundles (ex. 15 € par lot de 3)
      const isB = (p: any) => /^Bundle/.test(p.construction || "");
      const nbB = base.reduce((a, x) => a + (isB(x.p) ? x.qte : 0), 0);
      const lotT = num(R?.lotTaille) || 3, lotR = num(R?.lotRemise);
      const lotTotal = lotR > 0 ? Math.floor(nbB / lotT) * lotR : 0;
      const lotLigne = base.map((x, i) =>
        lotTotal > 0 && isB(x.p) ? Math.min(r2(lotTotal * x.qte / nbB), room[i]) : 0
      );
      const remiseLigne = base.map(() => 0);
      let promo: any = null;
      const code = String(b.code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "")
        .slice(0, 20);
      if (code) {
        const { data: e } = await admin.rpc("_parrainage_etat", {
          p_code: code,
        });
        if (!e || e.actif === false) {
          return json(req, { error: "code_inconnu" }, 400);
        }
        // titulaire : même e-mail, ou même téléphone, ou même nom si ni e-mail ni téléphone connus
        const { data: proprio } = await admin.rpc("est_titulaire", {
          c: e,
          p_nom: nom,
          p_email: email,
          p_tel: tel,
        });
        if (b.cagnotte === true) {
          if (!proprio) return json(req, { error: "cagnotte_autre" }, 400);
          const solde = num(e.solde);
          if (!(solde > 0)) return json(req, { error: "cagnotte_vide" }, 400);
          const roomTot = room.reduce((a, x) => a + x, 0);
          const montant = r2(Math.min(solde, roomTot));
          if (!(montant > 0)) return json(req, { error: "cagnotte_plancher" }, 400);
          let reste = montant;
          base.forEach((_, i) => {
            const v = i === base.length - 1
              ? reste
              : r2(montant * room[i] / roomTot);
            remiseLigne[i] = Math.min(v, room[i]);
            reste = r2(reste - remiseLigne[i]);
          });
          promo = { type: "cagnotte", code: e.code };
        } else {
          if (proprio) return json(req, { error: "code_perso" }, 400);
          if (sousTotal < num(e.min)) {
            return json(req, { error: "code_min", min: num(e.min) }, 400);
          }
          const { data: deja } = await admin.rpc("deja_parrainee", {
            p_nom: nom,
            p_email: email,
            p_tel: tel,
          });
          if (deja === true) return json(req, { error: "code_deja" }, 400);
          const pf = num(e.remise) || 10;
          base.forEach((x, i) => {
            remiseLigne[i] = Math.min(r2(x.prix * x.qte * pf / 100), room[i]);
          });
          promo = {
            type: "parrainage",
            code: e.code,
            pct: pf,
            gain: num(e.gain) || 10,
          };
        }
      }
      // un seul avantage par commande : on garde le plus intéressant pour la cliente
      const somme = (t: number[]) => t.reduce((a, x) => a + x, 0);
      if (lotTotal > 0 && somme(lotLigne) > somme(remiseLigne)) {
        lotLigne.forEach((v, i) => remiseLigne[i] = v);
        promo = { type: "lot", lots: Math.floor(nbB / lotT), taille: lotT };
      }
      // 3) lignes Stripe
      const lines: any[] = [], resv: any[] = [], details: any[] = [];
      base.forEach(({ p, qte, prix: prixInitial }, i) => {
        const prix = r2(prixInitial - remiseLigne[i] / qte);
        const remise = r2((prixInitial - prix) * qte);
        const promoTxt = remise > 0
          ? (promo.type === "cagnotte"
            ? ` · cagnotte −${fr(remise)} €`
            : promo.type === "lot"
            ? ` · remise lot de ${promo.taille} bundles`
            : ` · code ${promo.code} −${promo.pct} %`)
          : "";
        const t = titre(p);
        const surCommande = p.site?.mode === "commande" || p.disponible < qte;
        if (!surCommande) {
          lines.push({
            price_data: {
              currency: "eur",
              unit_amount: cents(prix),
              product_data: {
                name: t,
                ...(remise > 0
                  ? { description: `Prix ${fr(prixInitial)} €${promoTxt}` }
                  : {}),
              },
            },
            quantity: qte,
          });
          resv.push({ produit_id: p.id, quantite: qte });
          details.push({
            id: p.id,
            titre: t,
            qte,
            prix,
            prixInitial,
            remise,
            mode: "stock",
            paye: r2(prix * qte),
          });
        } else {
          const ac = r2(prix * pct / 100);
          lines.push({
            price_data: {
              currency: "eur",
              unit_amount: cents(ac),
              product_data: {
                name: `${t} · acompte ${pct} %`,
                description: `Création sur commande (prix ${fr(prix)} €${
                  remise > 0 ? ", au lieu de " + fr(prixInitial) + " €" : ""
                }). Solde à régler avant l'expédition.${promoTxt}`,
              },
            },
            quantity: qte,
          });
          details.push({
            id: p.id,
            titre: t,
            qte,
            prix,
            prixInitial,
            remise,
            mode: "commande",
            acompte: ac,
            paye: r2(ac * qte),
          });
        }
      });
      if (promo) promo.montant = r2(details.reduce((a, d) => a + d.remise, 0));
      const port = liv === "fr"
        ? num(R?.livraisonFR)
        : liv === "dom"
        ? num(R?.livraisonDOM)
        : 0;
      if (port > 0) {
        lines.push({
          price_data: {
            currency: "eur",
            unit_amount: cents(port),
            product_data: {
              name: liv === "fr"
                ? "Livraison France métropolitaine"
                : "Livraison outre-mer",
            },
          },
          quantity: 1,
        });
      }
      const total = r2(details.reduce((s, d) => s + d.paye, 0) + port);
      // création entièrement offerte : rien à payer en ligne, on passe par la Maison
      if (total < 1) return json(req, { error: "offert" }, 400);
      const params: any = {
        mode: "payment",
        locale: "fr",
        customer_email: email,
        expires_at: expires,
        success_url: `${SITE}/#/merci?s={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE}/#/panier`,
        phone_number_collection: { enabled: true },
        line_items: Object.fromEntries(lines.map((l, i) => [i, l])),
        metadata: { type: "commande", ...(promo?.code ? { code: promo.code } : {}) },
        payment_intent_data: {
          description: "Commande EUGCEO",
          metadata: { type: "commande" },
        },
      };
      if (liv !== "retrait") {
        params.shipping_address_collection = {
          allowed_countries: Object.fromEntries(
            (liv === "fr" ? ["FR"] : DOM).map((c, i) => [i, c]),
          ),
        };
      }
      const s = await stripeSession(params);
      await admin.from("paiements").insert({
        id: s.id,
        data: {
          type: "commande",
          statut: "en_attente",
          client: { nom, email, telephone: tel },
          livraison: liv,
          port,
          details,
          sousTotal,
          promo,
          total,
          creeLe: new Date().toISOString(),
          test: (Deno.env.get("STRIPE_SECRET_KEY") || "").startsWith("sk_test"),
        },
      });
      if (resv.length) {
        await admin.from("reservations").insert(
          resv.map((r) => ({
            ...r,
            session_id: s.id,
            expire_le: new Date((expires + 300) * 1000).toISOString(),
          })),
        );
      }
      return json(req, { url: s.url });
    }
    /* ---------- acompte d'un devis ---------- */
    if (b?.type === "devis") {
      const token = String(b.token || "");
      if (token.length < 20) return json(req, { error: "invalide" }, 400);
      const { data: rows } = await admin.from("devis").select("id,data").eq(
        "data->>token",
        token,
      ).limit(1);
      const d: any = rows && rows[0];
      if (!d) return json(req, { error: "introuvable" }, 404);
      const ac = num(d.data.acompte);
      if (d.data.statut !== "Accepté" || !(ac > 0)) {
        return json(req, { error: "indisponible" }, 409);
      }
      if (d.data.acomptePaye) return json(req, { error: "deja" }, 409);
      const params: any = {
        mode: "payment",
        locale: "fr",
        expires_at: expires,
        success_url: `${SITE}/#/devis/${encodeURIComponent(token)}`,
        cancel_url: `${SITE}/#/devis/${encodeURIComponent(token)}`,
        line_items: {
          0: {
            price_data: {
              currency: "eur",
              unit_amount: cents(ac),
              product_data: { name: `Acompte · devis ${d.data.numero}` },
            },
            quantity: 1,
          },
        },
        metadata: { type: "devis" },
        payment_intent_data: { description: `Acompte devis ${d.data.numero}` },
      };
      if (EMAIL.test(d.data.email || "")) params.customer_email = d.data.email;
      const s = await stripeSession(params);
      await admin.from("paiements").insert({
        id: s.id,
        data: {
          type: "devis",
          statut: "en_attente",
          devisId: d.id,
          numero: d.data.numero,
          client: {
            nom: d.data.client,
            email: d.data.email || "",
            telephone: d.data.telephone || "",
          },
          total: ac,
          creeLe: new Date().toISOString(),
          test: (Deno.env.get("STRIPE_SECRET_KEY") || "").startsWith("sk_test"),
        },
      });
      return json(req, { url: s.url });
    }
    /* ---------- solde d'une vente (depuis l'app, membres seulement) ---------- */
    if (b?.type === "solde") {
      const user = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        {
          global: {
            headers: { Authorization: req.headers.get("Authorization") || "" },
          },
        },
      );
      const { data: ok } = await user.rpc("est_membre");
      if (ok !== true) return json(req, { error: "interdit" }, 403);
      const { data: v } = await admin.from("ventes").select("id,data").eq(
        "id",
        String(b.venteId || ""),
      ).maybeSingle();
      if (!v) return json(req, { error: "introuvable" }, 404);
      const d: any = v.data;
      const q = Math.max(1, num(d.quantite) || 1);
      const total = r2(q * num(d.prixTTC) - num(d.remise) + num(d.port));
      const av = d.avanceType && d.avanceType !== "Aucune"
        ? num(d.avanceMontant)
        : 0;
      const reste = r2(total - av);
      if (d.statut !== "En attente de paiement" || !(reste > 0)) {
        return json(req, { error: "rien_a_payer" }, 409);
      }
      const params: any = {
        mode: "payment",
        locale: "fr",
        expires_at: now + 23 * 3600,
        success_url: `${SITE}/#/merci?solde=1`,
        cancel_url: `${SITE}/`,
        line_items: {
          0: {
            price_data: {
              currency: "eur",
              unit_amount: cents(reste),
              product_data: {
                name: `Solde · ${d.designation || "commande"}${
                  d.numero ? " · facture " + d.numero : ""
                }`,
              },
            },
            quantity: 1,
          },
        },
        metadata: { type: "solde" },
        payment_intent_data: { description: `Solde ${d.numero || ""}` },
      };
      if (EMAIL.test(d.email || "")) params.customer_email = d.email;
      const s = await stripeSession(params);
      await admin.from("paiements").insert({
        id: s.id,
        data: {
          type: "solde",
          statut: "en_attente",
          venteId: v.id,
          numero: d.numero || "",
          client: {
            nom: d.client,
            email: d.email || "",
            telephone: d.telephone || "",
          },
          total: reste,
          creeLe: new Date().toISOString(),
          test: (Deno.env.get("STRIPE_SECRET_KEY") || "").startsWith("sk_test"),
        },
      });
      return json(req, {
        url: s.url,
        montant: reste,
        expire: new Date((now + 23 * 3600) * 1000).toISOString(),
      });
    }
    return json(req, { error: "invalide" }, 400);
  } catch (e) {
    const m = String((e as Error)?.message || e);
    console.error("paiement", m);
    return json(req, {
      error: m === "non_configure" ? "non_configure" : "erreur",
    }, m === "non_configure" ? 200 : 500);
  }
});
