// Vercel 备用部署的 /proxy 实现（移植自 functions/proxy.ts 的 Cloudflare 版本）
// 作用与主站一致：转发 GD 音乐台 API + 酷我音频直链代理；缓存由内存 Map 代替 Cache API。
export const config = { runtime: "edge" };

const DEFAULT_API_BASE_URL = "https://music-api.gdstudio.xyz/api.php";
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];

// 简易内存缓存（实例存活期内有效，冷启动即失效，仅作加速）
const memCache = new Map();
const MEM_CACHE_TTL_MS = 300 * 1000;
const MEM_CACHE_MAX_ENTRIES = 200;

function createCorsHeaders(init) {
  const headers = new Headers();
  if (init) {
    for (const [key, value] of init.entries()) {
      if (SAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
  }
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function isAllowedKuwoHost(hostname) {
  if (!hostname) return false;
  return KUWO_HOST_PATTERN.test(hostname);
}

function normalizeKuwoUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!isAllowedKuwoHost(parsed.hostname)) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.protocol = "http:";
    return parsed;
  } catch {
    return null;
  }
}

async function proxyKuwoAudio(targetUrl, request) {
  const normalized = normalizeKuwoUrl(targetUrl);
  if (!normalized) {
    return new Response("Invalid target", { status: 400 });
  }

  const reqHeaders = {
    "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
    "Referer": "https://www.kuwo.cn/",
  };
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    reqHeaders["Range"] = rangeHeader;
  }

  const upstream = await fetch(normalized.toString(), {
    method: request.method,
    headers: reqHeaders,
  });
  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "public, max-age=3600");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function proxyApiRequest(url, request, apiBaseUrl) {
  // 缓存 Key：去掉随机签名 s 与强制刷新标记 nocache（与主站逻辑一致）
  const cacheUrl = new URL(url.toString());
  cacheUrl.searchParams.delete("s");
  cacheUrl.searchParams.delete("nocache");
  const cacheKey = cacheUrl.toString();

  const bypassCache = url.searchParams.get("nocache") === "true";
  if (request.method === "GET" && !bypassCache) {
    const hit = memCache.get(cacheKey);
    if (hit && Date.now() - hit.timestamp < MEM_CACHE_TTL_MS) {
      const headers = new Headers(hit.headers);
      headers.set("X-Cache-Status", "HIT");
      headers.set("Access-Control-Expose-Headers", "X-Cache-Status");
      return new Response(hit.text, { status: hit.status, headers });
    }
    if (hit) memCache.delete(cacheKey);
  }

  const apiUrl = new URL(apiBaseUrl);
  url.searchParams.forEach((value, key) => {
    if (key === "target" || key === "callback" || key === "s" || key === "nocache") {
      return;
    }
    apiUrl.searchParams.set(key, value);
  });

  if (!apiUrl.searchParams.has("types")) {
    return new Response("Missing types", { status: 400 });
  }

  const upstream = await fetch(apiUrl.toString(), {
    headers: {
      "User-Agent": "Meting/1.5.0",
      "Accept": "application/json",
    },
  });

  const responseText = await upstream.text();
  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  headers.set("X-Cache-Status", "MISS");
  headers.set("Access-Control-Expose-Headers", "X-Cache-Status");

  const isSearch = url.searchParams.get("types") === "search";
  const isEmptyResult = responseText.trim() === "[]";
  const isError = responseText.includes('"error"') || responseText.includes('"status":0');

  let shouldCache = upstream.status === 200 && request.method === "GET" && !isError && !bypassCache;
  if (isSearch && isEmptyResult) {
    shouldCache = false;
  }

  if (shouldCache) {
    headers.set("Cache-Control", "public, s-maxage=300, max-age=300");
    if (memCache.size >= MEM_CACHE_MAX_ENTRIES) {
      const firstKey = memCache.keys().next().value;
      if (firstKey) memCache.delete(firstKey);
    }
    memCache.set(cacheKey, {
      status: upstream.status,
      headers: Array.from(headers.entries()),
      text: responseText,
      timestamp: Date.now(),
    });
  } else {
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate");
  }

  return new Response(responseText, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export default async function handler(request) {
  const apiBaseUrl =
    (typeof process !== "undefined" && process.env && process.env.API_BASE_URL) || DEFAULT_API_BASE_URL;

  if (request.method === "OPTIONS") {
    return handleOptions();
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("target");
  if (target) {
    return proxyKuwoAudio(target, request);
  }
  return proxyApiRequest(url, request, apiBaseUrl);
}
