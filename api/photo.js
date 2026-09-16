import { get, list } from "@vercel/blob";
import { hasValidSession, syncConfigured } from "./_auth.js";

const PHOTO_PREFIX = "farm-log/photos/";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, max-age=3600");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end();
  }
  if (!syncConfigured()) return res.status(503).end();
  if (!hasValidSession(req)) return res.status(401).end();

  const id = String(req.query?.id || "");
  if (!/^[0-9A-Za-z_-]+$/.test(id)) return res.status(400).end();

  try {
    const { blobs } = await list({ prefix: `${PHOTO_PREFIX}${id}.`, limit: 10 });
    const blob = blobs[0];
    if (!blob) return res.status(404).end();
    const result = await get(blob.url, { access: "private" });
    if (!result) return res.status(404).end();
    const bytes = Buffer.from(await new Response(result.stream).arrayBuffer());
    res.setHeader("Content-Type", blob.contentType || "image/jpeg");
    return res.status(200).send(bytes);
  } catch (error) {
    console.error("farm-log photo error", error);
    return res.status(500).end();
  }
}
