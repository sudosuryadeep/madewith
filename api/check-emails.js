import { google } from "googleapis";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const b64 = (s = "") => Buffer.from(s, "base64").toString("utf8");
const decodePart = (part) => {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return b64(part.body.data);
  if (part.parts) return part.parts.map(decodePart).filter(Boolean).join("\n");
  return "";
};
const header = (headers, name) =>
  headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

function getGmail() {
  const oauth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || "https://developers.google.com/oauthplayground"
  );
  oauth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth: oauth });
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Missing Telegram configuration");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error("Telegram send failed");
}

function escapeHtml(s = "") {
  return String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  const supplied = req.query?.key || "";
  if (secret && auth !== `Bearer ${secret}` && supplied !== secret) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const gmail = getGmail();
    // Narrow the search to FamApp/FamPay payment-received emails.
    const query = process.env.GMAIL_SEARCH_QUERY ||
      'newer_than:2d (from:famapp.in OR from:famapp.com) (subject:received OR subject:payment OR "successfully received")';
    const list = await gmail.users.messages.list({
      userId: "me", q: query, maxResults: 25
    });
    const messages = list.data.messages || [];
    let sent = 0, skipped = 0;

    for (const item of messages.reverse()) {
      const key = `famapp-alert:${item.id}`;
      if (await redis.get(key)) { skipped++; continue; }

      const full = await gmail.users.messages.get({
        userId: "me", id: item.id, format: "full"
      });
      const payload = full.data.payload || {};
      const headers = payload.headers || [];
      const from = header(headers, "From");
      const subject = header(headers, "Subject") || "FamApp payment email";
      const date = header(headers, "Date") || "";
      const body = decodePart(payload);
      const text = `${subject}\n${body}`.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

      // Only forward likely payment-received notifications, not arbitrary email.
      if (!/famapp|fam\.?pay/i.test(from) ||
          !/successfully received|received.*₹|payment received|you have successfully received/i.test(text)) {
        await redis.set(key, "ignored", { ex: 60 * 60 * 24 * 14 });
        skipped++;
        continue;
      }

      const amount = text.match(/₹\s?[\d,]+(?:\.\d{1,2})?/i)?.[0] || "Amount not detected";
      const senderMatch = text.match(/\bfrom\s+([A-Z][A-Za-z .'-]{1,60}?)(?=\s+(?:Transaction ID|Date|Updated Balance)|[.,]|$)/i);
      const sender = senderMatch?.[1]?.trim() || "Not detected";
      const txMatch = text.match(/Transaction ID\s*:\s*([A-Z0-9-]+)/i);
      const txn = txMatch?.[1] || "Not detected";
      const safeMessage =
        `💸 <b>FamApp Payment Received</b>\n\n` +
        `💰 <b>Amount:</b> ${escapeHtml(amount)}\n` +
        `👤 <b>From:</b> ${escapeHtml(sender)}\n` +
        `🧾 <b>Transaction ID:</b> <code>${escapeHtml(txn)}</code>\n` +
        `🕒 <b>Email date:</b> ${escapeHtml(date)}\n` +
        `✉️ <b>Subject:</b> ${escapeHtml(subject)}\n\n` +
        `<i>Alert generated from your Gmail notification.</i>`;
      await sendTelegram(safeMessage);
      await redis.set(key, "sent", { ex: 60 * 60 * 24 * 14 });
      sent++;
    }
    return res.status(200).json({ ok: true, found: messages.length, sent, skipped });
  } catch (err) {
    console.error("Payment alert error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Check server logs and environment variables." });
  }
}