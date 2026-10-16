import { get, put } from "@vercel/blob";
import { randomUUID, timingSafeEqual } from "node:crypto";

const DATA_PATH = "farm-log/entries.json";
const MAX_ENTRIES = 10000;
const TYPE_EMOJIS = {
  "収穫": "🍓",
  "灌水": "💧",
  "液肥": "🧪",
  "防除": "🐛",
  "生育": "🌱",
  "その他": "🔧",
  "予定": "🗓️",
};

function sendJson(response, data, status = 200) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(data));
}

function authorized(request) {
  const expected = process.env.FARM_LOG_SYNC_KEY;
  const supplied = request.headers["x-farm-log-key"] || "";
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function clean(value, max = 300) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeEntry(input = {}) {
  const date = clean(input.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("INVALID_DATE");
  }

  const requestedType = clean(input.type, 20);
  const type = Object.prototype.hasOwnProperty.call(TYPE_EMOJIS, requestedType)
    ? requestedType
    : "その他";
  const planned = type === "予定" || input.planned === true;

  return {
    id: input.id ? clean(input.id, 100) : randomUUID(),
    type,
    emoji: TYPE_EMOJIS[type],
    date,
    time: clean(input.time, 5),
    crop: clean(input.crop || "いちご", 80),
    place: clean(input.place, 120),
    detail: clean(input.detail, 500),
    amount: clean(input.amount, 120),
    subamount: clean(input.subamount, 120),
    note: clean(input.note, 3000),
    photo: "",
    planned,
    moonRule: planned ? clean(input.moonRule, 40) : "",
    moonOffset: planned ? Math.max(0, Math.min(14, Number(input.moonOffset) || 0)) : 0,
  };
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

async function writeEntries(entries) {
  const payload = JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    entries,
  });

  await put(DATA_PATH, payload, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
    cacheControlMaxAge: 60,
  });
}

function sameEntry(a, b) {
  return ["date", "type", "crop", "place", "detail", "amount", "subamount", "note"]
    .every((key) => String(a?.[key] ?? "") === String(b?.[key] ?? ""));
}

export default async function handler(request, response) {
  if (!process.env.FARM_LOG_SYNC_KEY) {
    return sendJson(response, { error: "同期コードがVercelに設定されていません" }, 503);
  }
  if (!authorized(request)) {
    return sendJson(response, { error: "同期コードが違います" }, 401);
  }

  try {
    if (request.method === "GET") {
      return sendJson(response, { entries: await readEntries() });
    }

    if (request.method === "POST") {
      const body = typeof request.body === "string"
        ? JSON.parse(request.body)
        : request.body;
      if (!body || typeof body.entry !== "object") {
        return sendJson(response, { error: "追記する日誌データがありません" }, 400);
      }

      let entry;
      try {
        entry = normalizeEntry(body.entry);
      } catch (error) {
        if (error.message === "INVALID_DATE") {
          return sendJson(response, { error: "日付の形式が正しくありません" }, 400);
        }
        throw error;
      }

      const idempotencyKey = clean(body.idempotencyKey, 160);
      const entries = await readEntries();
      const duplicate = idempotencyKey
        ? entries.find((item) => item?.idempotencyKey === idempotencyKey)
        : entries.find((item) => sameEntry(item, entry));

      if (duplicate) {
        return sendJson(response, {
          ok: true,
          changed: false,
          count: entries.length,
          entry: duplicate,
        });
      }

      if (entries.length >= MAX_ENTRIES) {
        return sendJson(response, { error: "記録件数が上限に達しています" }, 413);
      }

      if (idempotencyKey) entry.idempotencyKey = idempotencyKey;
      entry.source = "append-api";
      entries.unshift(entry);
      await writeEntries(entries);

      return sendJson(response, {
        ok: true,
        changed: true,
        count: entries.length,
        entry,
      });
    }

    if (request.method === "PUT") {
      const contentLength = Number(request.headers["content-length"] || 0);
      if (contentLength > 4_000_000) {
        return sendJson(response, { error: "写真を含むデータ量が上限を超えています" }, 413);
      }

      const body = typeof request.body === "string"
        ? JSON.parse(request.body)
        : request.body;
      if (!body || !Array.isArray(body.entries)) {
        return sendJson(response, { error: "日誌データの形式が正しくありません" }, 400);
      }
      if (body.entries.length > MAX_ENTRIES) {
        return sendJson(response, { error: "記録件数が上限を超えています" }, 413);
      }

      await writeEntries(body.entries);
      return sendJson(response, { ok: true, count: body.entries.length });
    }

    return sendJson(response, { error: "Method not allowed" }, 405);
  } catch (error) {
    console.error("farm-log sync error", error);
    return sendJson(response, { error: "クラウド同期に失敗しました" }, 500);
  }
}
