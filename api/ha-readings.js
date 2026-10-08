import { get, put } from "@vercel/blob";
import { timingSafeEqual } from "node:crypto";

const DATA_PATH = "farm-log/ha-readings.json";
const MAX_READINGS = 50000;

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
  const b = Buffer.from(String(supplied));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readReadings() {
  const result = await get(DATA_PATH, { access: "private", useCache: false });
  if (!result || result.statusCode === 404) return [];
  if (result.statusCode !== 200) throw new Error(`Blob read failed (${result.statusCode})`);
  const text = await new Response(result.stream).text();
  const stored = JSON.parse(text);
  return Array.isArray(stored) ? stored : stored.readings || [];
}

function n(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function ms(value) {
  const x = Date.parse(value);
  return Number.isFinite(x) ? x : null;
}

function avg(values) {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function dailySummary(readings) {
  const groups = new Map();
  for (const r of readings) {
    const date = String(r.localDate || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(r);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => {
    const t = rows.map(r => r.temperature).filter(Number.isFinite);
    const h = rows.map(r => r.humidity).filter(Number.isFinite);
    const s = rows.map(r => r.soilTemperature).filter(Number.isFinite);
    return {
      date,
      samples: rows.length,
      temperatureAvg: avg(t),
      temperatureMin: t.length ? Math.min(...t) : null,
      temperatureMax: t.length ? Math.max(...t) : null,
      humidityAvg: avg(h),
      humidityMin: h.length ? Math.min(...h) : null,
      humidityMax: h.length ? Math.max(...h) : null,
      soilTemperatureAvg: avg(s),
      soilTemperatureMin: s.length ? Math.min(...s) : null,
      soilTemperatureMax: s.length ? Math.max(...s) : null,
    };
  });
}

export default async function handler(request, response) {
  if (!process.env.FARM_LOG_SYNC_KEY) {
    return sendJson(response, { error: "同期コードがVercelに設定されていません" }, 503);
  }
  if (!authorized(request)) {
    return sendJson(response, { error: "認証に失敗しました" }, 401);
  }

  try {
    if (request.method === "POST") {
      const body = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
      if (!body || typeof body !== "object") return sendJson(response, { error: "データ形式が正しくありません" }, 400);

      const timestamp = String(body.timestamp || new Date().toISOString());
      if (ms(timestamp) === null) return sendJson(response, { error: "timestamp が正しくありません" }, 400);

      const localDate = String(body.localDate || "");
      const reading = {
        timestamp,
        localDate: /^\d{4}-\d{2}-\d{2}$/.test(localDate) ? localDate : timestamp.slice(0, 10),
        place: String(body.place || "2号ハウス").slice(0, 80),
        temperature: n(body.temperature),
        humidity: n(body.humidity),
        soilTemperature: n(body.soilTemperature),
      };

      if ([reading.temperature, reading.humidity, reading.soilTemperature].every(v => v === null)) {
        return sendJson(response, { error: "保存できるセンサー値がありません" }, 400);
      }

      let readings = await readReadings();
      const key = `${reading.place}|${reading.timestamp}`;
      readings = readings.filter(r => `${r.place}|${r.timestamp}` !== key);
      readings.push(reading);
      readings.sort((a, b) => ms(a.timestamp) - ms(b.timestamp));
      if (readings.length > MAX_READINGS) readings = readings.slice(-MAX_READINGS);

      await put(DATA_PATH, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), readings }), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json; charset=utf-8",
        cacheControlMaxAge: 60,
      });

      return sendJson(response, { ok: true, stored: readings.length });
    }

    if (request.method === "GET") {
      let readings = await readReadings();
      const place = String(request.query.place || "");
      const from = request.query.from ? ms(String(request.query.from)) : null;
      const to = request.query.to ? ms(String(request.query.to)) : null;
      const limit = Math.min(Math.max(Number(request.query.limit) || 5000, 1), 50000);

      if (place) readings = readings.filter(r => r.place === place);
      if (from !== null) readings = readings.filter(r => ms(r.timestamp) >= from);
      if (to !== null) readings = readings.filter(r => ms(r.timestamp) <= to);
      readings = readings.slice(-limit);

      if (String(request.query.daily || "") === "1") return sendJson(response, { daily: dailySummary(readings), count: readings.length });
      return sendJson(response, { readings, count: readings.length });
    }

    return sendJson(response, { error: "Method not allowed" }, 405);
  } catch (error) {
    console.error("HA readings sync error", error);
    return sendJson(response, { error: "Home Assistantデータの保存・取得に失敗しました" }, 500);
  }
}
