import { sessionCookie, syncConfigured, verifySyncCode } from "./_auth.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (!syncConfigured()) {
    return res.status(503).json({ error: "sync_not_configured" });
  }
  const code = String(req.body?.code || "");
  if (!verifySyncCode(code)) {
    return res.status(401).json({ error: "invalid_code" });
  }
  res.setHeader("Set-Cookie", sessionCookie());
  return res.status(200).json({ ok: true });
}
