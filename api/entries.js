import { del, get, list, put } from "@vercel/blob";
import { hasValidSession, syncConfigured } from "./_auth.js";

const STATE_PATH = "farm-log/state.json";
const PHOTO_PREFIX = "farm-log/photos/";

async function loadEntries() {
  const { blobs } = await list({ prefix: STATE_PATH, limit: 10 });
  const stateBlob = blobs.find(blob => blob.pathname === STATE_PATH);
  if (!stateBlob) return [];
  const result = await get(stateBlob.url, { access: "private" });
  if (!result) return [];
  const text = await new Response(result.stream).text();
  const state = JSON.parse(text);
  return Array.isArray(state.entries) ? state.entries : [];
}

async function saveEntries(entries) {
  await put(
    STATE_PATH,
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries }),
    {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
      contentType: "application/json"
    }
  );
}

function sameId(a, b) {
  return String(a) === String(b);
}

async function normalizePhoto(entry) {
  const next = { ...entry };
  const match = /^data:([^;]+);base64,(.+)$/.exec(String(next.photo || ""));
  if (!match) return next;
  const contentType = match[1];
  const extension = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  const pathname = `${PHOTO_PREFIX}${String(next.id)}.${extension}`;
  await put(pathname, Buffer.from(match[2], "base64"), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 86400,
    contentType
  });
  next.photoPath = pathname;
  next.photo = `/api/photo?id=${encodeURIComponent(String(next.id))}`;
  return next;
}

async function removePhoto(entry) {
  if (!entry?.photoPath) return;
  await del(entry.photoPath).catch(() => {});
}

async function clearPhotos() {
  let cursor;
  do {
    const result = await list({ prefix: PHOTO_PREFIX, cursor, limit: 1000 });
    if (result.blobs.length) {
      await del(result.blobs.map(blob => blob.url)).catch(() => {});
    }
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!syncConfigured()) {
    return res.status(503).json({ error: "sync_not_configured" });
  }
  if (!hasValidSession(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    let entries = await loadEntries();
    if (req.method === "GET") {
      return res.status(200).json({ entries });
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "method_not_allowed" });
    }

    const action = req.body?.action;
    if (action === "merge") {
      const incoming = Array.isArray(req.body.entries) ? req.body.entries : [];
      const merged = new Map(entries.map(entry => [String(entry.id), entry]));
      for (const entry of incoming) {
        const normalized = await normalizePhoto(entry);
        merged.set(String(normalized.id), normalized);
      }
      entries = [...merged.values()].sort((a, b) =>
        String(b.date || "") .concat(String(b.time || "")).localeCompare(
          String(a.date || "").concat(String(a.time || ""))
        )
      );
    } else if (action === "upsert" && req.body.entry) {
      const normalized = await normalizePhoto(req.body.entry);
      const previous = entries.find(entry => sameId(entry.id, normalized.id));
      if (previous?.photoPath && previous.photoPath !== normalized.photoPath) {
        await removePhoto(previous);
      }
      entries = [normalized, ...entries.filter(entry => !sameId(entry.id, normalized.id))];
    } else if (action === "delete") {
      const removed = entries.find(entry => sameId(entry.id, req.body.id));
      entries = entries.filter(entry => !sameId(entry.id, req.body.id));
      await removePhoto(removed);
    } else if (action === "clear") {
      entries = [];
      await clearPhotos();
    } else {
      return res.status(400).json({ error: "invalid_action" });
    }

    await saveEntries(entries);
    return res.status(200).json({ ok: true, entries });
  } catch (error) {
    console.error("farm-log sync error", error);
    return res.status(500).json({ error: "sync_failed" });
  }
}
