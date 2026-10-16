import { get, put } from "@vercel/blob";
import { randomUUID } from "node:crypto";

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
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(data));
}

function clean(value, max = 300) {
  return String(value ?? "").trim().slice(0, max);
}

function assistantAccessOnly(request) {
  const host = clean(request.headers.host, 300).split(":")[0].toLowerCase();
  const deploymentHost = clean(process.env.VERCEL_URL, 300).toLowerCase();
  return Boolean(
    process.env.VERCEL_ENV === "production" &&
    host &&
    deploymentHost &&
    host === deploymentHost
  );
}

async function readEntries() {
  const result = await get(DATA_PATH, { access: "private", useCache: false });
  if (!result || result.statusCode === 404) return [];
  if (result.statusCode !== 200) throw new Error(`Blob read failed (${result.statusCode})`);
  const text = await new Response(result.stream).text();
  const stored = JSON.parse(text);
  return Array.isArray(stored) ? stored : stored.entries || [];
}

async function writeEntries(entries) {
  await put(DATA_PATH, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    entries,
  }), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
    cacheControlMaxAge: 60,
  });
}

function normalizeQuery(query) {
  const date = clean(query.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("INVALID_DATE");
  const requestedType = clean(query.type || "その他", 20);
  const type = Object.prototype.hasOwnProperty.call(TYPE_EMOJIS, requestedType)
    ? requestedType
    : "その他";
  const planned = type === "予定" || query.planned === "1";
  return {
    id: randomUUID(),
    type,
    emoji: TYPE_EMOJIS[type],
    date,
    time: clean(query.time, 5),
    crop: clean(query.crop || "いちご", 80),
    place: clean(query.place, 120),
    detail: clean(query.detail, 500),
    amount: clean(query.amount, 120),
    subamount: clean(query.subamount, 120),
    note: clean(query.note, 3000),
    photo: "",
    planned,
    moonRule: planned ? clean(query.moonRule, 40) : "",
    moonOffset: planned ? Math.max(0, Math.min(14, Number(query.moonOffset) || 0)) : 0,
    source: "assistant-api",
  };
}

function sameEntry(a, b) {
  return ["date", "type", "crop", "place", "detail", "amount", "subamount", "note"]
    .every((key) => String(a?.[key] ?? "") === String(b?.[key] ?? ""));
}

export default async function handler(request, response) {
  if (request.method !== "GET") {
    return sendJson(response, { error: "Method not allowed" }, 405);
  }
  if (!assistantAccessOnly(request)) {
    return sendJson(response, { error: "この経路からは追記できません" }, 403);
  }

  try {
    const entry = normalizeQuery(request.query || {});
    const key = clean(request.query?.key, 160);
    const entries = await readEntries();
    const duplicate = key
      ? entries.find((item) => item?.assistantKey === key)
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

    if (key) entry.assistantKey = key;
    entries.unshift(entry);
    await writeEntries(entries);

    return sendJson(response, {
      ok: true,
      changed: true,
      count: entries.length,
      entry,
    });
  } catch (error) {
    if (error.message === "INVALID_DATE") {
      return sendJson(response, { error: "日付の形式が正しくありません" }, 400);
    }
    console.error("assistant farm-log append error", error);
    return sendJson(response, { error: "日誌の追記に失敗しました" }, 500);
  }
}
