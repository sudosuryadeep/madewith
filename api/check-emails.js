
import { google } from "googleapis";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

function decode(data = "") {
  return Buffer.from(
    data.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  ).toString("utf8");
}

function getBody(part) {
  if (!part) return "";

  let text = "";

  if (part.body?.data) {
    const decoded = decode(part.body.data);

    if (part.mimeType === "text/plain") {
      text += decoded + "\n";
    } else if (part.mimeType === "text/html") {
      text += decoded.replace(/<[^>]*>/g, " ") + "\n";
    }
  }

  for (const child of part.parts || []) {
    text += getBody(child);
  }

  return text;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.CRON_SECRET;

  if (
    secret &&
    req.headers.authorization !== `Bearer ${secret}`
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const oauth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI ||
        "https://developers.google.com/oauthplayground"
    );

    oauth.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN
    });

    const gmail = google.gmail({ version: "v1", auth: oauth });

    const result = await gmail.users.messages.list({
      userId: "me",
      q: process.env.GMAIL_SEARCH_QUERY ||
        'newer_than:2d {from:famapp.in from:fampay.in from:famapp.com}',
      maxResults: 50
    });

    let sent = 0;
    let skipped = 0;

    for (const msg of (result.data.messages || []).reverse()) {
      const key = `payment-alert:${msg.id}`;

      if (await redis.get(key)) {
        skipped++;
        continue;
      }

      const result = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "full"
      });

      const payload = result.data.payload || {};
      const headers = payload.headers || [];

      const getHeader = name =>
        headers.find(
          h => h.name?.toLowerCase() === name.toLowerCase()
        )?.value || "";

      const subject = getHeader("Subject") || "Payment notification";
      const body = getBody(payload);
      const content = `${subject}\n${body}`;

      const payment =
        /\b(payment|paid|sent|received|credited|debited|transaction|transfer)\b|₹/i
          .test(content);

      const failed =
        /\b(payment failed|transaction failed|payment declined|transaction declined)\b/i
          .test(content);

      if (!payment || failed) {
        await redis.set(key, "ignored", { ex: 1209600 });
        skipped++;
        continue;
      }

      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;

      if (!token || !chatId) {
        throw new Error("Telegram configuration missing");
      }

      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text:
              `💸 FamPay Payment Alert\n\n` +
              `📩 ${subject}\n\n` +
              body.replace(/\s+/g, " ").slice(0, 2500),
            disable_web_page_preview: true
          })
        }
      );

      const telegram = await response.json();

      if (!response.ok || !telegram.ok) {
        throw new Error("Telegram message delivery failed");
      }

      await redis.set(key, "sent", { ex: 1209600 });
      sent++;
    }

    return res.status(200).json({
      ok: true,
      sent,
      skipped
    });
  } catch (error) {
    console.error("Payment alert error:", error.message);
    return res.status(500).json({
      ok: false,
      error: "Check Vercel function logs"
    });
  }
}
