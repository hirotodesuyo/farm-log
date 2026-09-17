import { get, put } from "@vercel/blob";
import { timingSafeEqual } from "node:crypto";

const DATA_PATH = "farm-log/entries.json";
const MAX_ENTRIES = 10000;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function authorized(request) {
  const expected = process.env.FARM_LOG_SYNC_KEY;
  const supplied = request.headers.get("x-farm-log-key") || "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readEntries() {
  const result = await get(DATA_PATH, {
    access: "private",
    useCache: false,
  });

  if (!result || result.statusCode === 404) return [];
  if (result.statusCode !== 200) {
    throw new Error(`Blob read failed (${result.statusCode})`);
  }

  const text = await new Response(result.stream).text();
  const stored = JSON.parse(text);
  return Array.isArray(stored) ? stored : stored.entries || [];
}

export default async function handler(request) {
  if (!process.env.FARM_LOG_SYNC_KEY) {
    return json({ error: "同期コードがVercelに設定されていません" }, 503);
  }
  if (!authorized(request)) {
    return json({ error: "同期コードが違います" }, 401);
  }

  try {
    if (request.method === "GET") {
      return json({ entries: await readEntries() });
    }

    if (request.method === "PUT") {
      const contentLength = Number(request.headers.get("content-length") || 0);
      if (contentLength > 4_000_000) {
        return json({ error: "写真を含むデータ量が上限を超えています" }, 413);
      }

      const body = await request.json();
      if (!body || !Array.isArray(body.entries)) {
        return json({ error: "日誌データの形式が正しくありません" }, 400);
      }
      if (body.entries.length > MAX_ENTRIES) {
        return json({ error: "記録件数が上限を超えています" }, 413);
      }

      const payload = JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: body.entries,
      });

      await put(DATA_PATH, payload, {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json; charset=utf-8",
        cacheControlMaxAge: 60,
      });

      return json({ ok: true, count: body.entries.length });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    console.error("farm-log sync error", error);
    return json({ error: "クラウド同期に失敗しました" }, 500);
  }
}
