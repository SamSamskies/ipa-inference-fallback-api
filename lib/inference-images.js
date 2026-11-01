import dns from "node:dns/promises";
import { isIP } from "node:net";
import { discardBody, isPrivateOrLocalHostname, pinnedFetch } from "./safeUrl.js";
import { guessImageMime, normalizeImageMime } from "./inference-request.js";
import { inferenceError } from "./inference-response.js";

function inlineImageBytes(contents) {
  let total = 0;
  for (const content of contents) {
    for (const part of content.parts) {
      const data = part.image?.data;
      if (typeof data !== "string" || !data) continue;
      const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
      total += Math.max(0, Math.floor((data.length * 3) / 4) - padding);
    }
  }
  return total;
}

export const MAX_INLINE_IMAGE_BYTES = 4_000_000;
const MAX_IMAGE_FETCH_REDIRECTS = 5;

function hasImageUrls(contents) {
  return contents.some((content) =>
    content.parts.some((part) => part.image?.url)
  );
}

function hasInlineImages(contents) {
  return contents.some((content) =>
    content.parts.some((part) => part.image?.data)
  );
}

// Remove the client's vision hint when no images survive fetching. The service
// never adds application prompts; the frontends own this instruction.
const VISION_SYSTEM_LINE =
  "The first user message includes the note's images before the text. Look at those images when they matter.";

function stripVisionSystemLine(system) {
  if (typeof system !== "string" || !system) return system;
  return system
    .split("\n")
    .filter((line) => line !== VISION_SYSTEM_LINE)
    .join("\n");
}

/** Failed image downloads retain their URLs as text for every provider. */
export function fallbackUnreadImages(contents) {
  return contents.map((content) => {
    const kept = [];
    const unreadUrls = [];
    for (const part of content.parts) {
      if (part.image?.url) unreadUrls.push(part.image.url);
      else kept.push(part);
    }
    if (unreadUrls.length === 0) return content;
    const existingText = kept
      .filter((part) => typeof part.text === "string")
      .map((part) => part.text)
      .join("\n\n");
    const extraUrls = unreadUrls.filter((url) => url && !existingText.includes(url));
    if (extraUrls.length === 0) return { ...content, parts: kept };
    const extra = extraUrls.join("\n");
    const parts = kept.slice();
    let lastText = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (typeof parts[i].text === "string") {
        lastText = i;
        break;
      }
    }
    if (lastText >= 0) {
      const text = parts[lastText].text;
      parts[lastText] = { text: text ? `${text}\n\n${extra}` : extra };
    } else {
      parts.push({ text: extra });
    }
    return { ...content, parts };
  });
}

/**
 * DNS lookup used before fetching note images. Tests replace `lookupAll` so
 * they can simulate public vs private answers without a network.
 */
export const imageFetchDns = {
  lookupAll(hostname) {
    return dns.lookup(hostname, { all: true });
  },
};

async function assertSafeImageFetchUrl(fileUri, base) {
  let parsed;
  try {
    parsed = base ? new URL(fileUri, base) : new URL(fileUri);
  } catch {
    throw new Error("image_fetch_url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("image_fetch_url");
  }
  if (parsed.username || parsed.password) {
    throw new Error("image_fetch_url");
  }
  if (isPrivateOrLocalHostname(parsed.hostname)) {
    throw new Error("image_fetch_url");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    return { url: parsed, address: host, family: host.includes(":") ? 6 : 4 };
  }
  let records;
  try {
    records = await imageFetchDns.lookupAll(host);
  } catch {
    throw new Error("image_fetch_url");
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("image_fetch_url");
  }
  for (const record of records) {
    const address = record?.address;
    if (!address || isPrivateOrLocalHostname(address)) {
      throw new Error("image_fetch_url");
    }
  }
  const first = records[0];
  return {
    url: parsed,
    address: first.address,
    family: first.family ?? (first.address.includes(":") ? 6 : 4),
  };
}

async function fetchImageAsInlineData(fileUri, mimeType, signal) {
  let current = await assertSafeImageFetchUrl(fileUri);
  let res;

  for (let hop = 0; hop <= MAX_IMAGE_FETCH_REDIRECTS; hop++) {
    res = await pinnedFetch(current, {
      signal,
      headers: {
        // Some media CDNs reject bare bot fetches.
        Accept: "image/*,*/*;q=0.8",
        "User-Agent": "ipa-inference-fallback-api/1.0",
      },
    });

    if (res.status < 300 || res.status >= 400) break;

    const location = res.headers.get("location");
    await discardBody(res);
    if (!location) throw new Error("image_fetch_url");
    // Re-validate every hop so redirects cannot pivot into private/metadata nets.
    current = await assertSafeImageFetchUrl(location, current.url.href);
  }

  if (!res || (res.status >= 300 && res.status < 400)) {
    await discardBody(res);
    throw new Error("image_fetch_url");
  }
  if (!res.ok) {
    await discardBody(res);
    throw new Error(`image_fetch_http_${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_INLINE_IMAGE_BYTES) {
    throw new Error("image_fetch_size");
  }
  const headerMime = normalizeImageMime(
    (res.headers.get("content-type") || "").split(";")[0]
  );
  const mime =
    headerMime ||
    normalizeImageMime(mimeType) ||
    guessImageMime(current.url.href);
  return {
    image: {
      mediaType: mime,
      data: buffer.toString("base64"),
    },
  };
}

/** Abort failures must stop generation instead of silently dropping images. */
function isAbortError(error, signal) {
  return Boolean(signal?.aborted) || error?.name === "AbortError" || error?.name === "TimeoutError";
}

async function resolveImagesToInline(contents, signal) {
  const next = [];
  for (const content of contents) {
    const parts = [];
    for (const part of content.parts) {
      if (!part.image?.url) {
        parts.push(part);
        continue;
      }
      try {
        parts.push(
          await fetchImageAsInlineData(
            part.image.url,
            part.image.mediaType,
            signal
          )
        );
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        console.warn("[api/inference] image fetch failed", {
          uri: String(part.image.url).slice(0, 120),
          error: error instanceof Error ? error.message : "unknown",
        });
        parts.push(part);
      }
    }
    next.push({ ...content, parts });
  }
  return next;
}

/** Resolve images within the generation deadline, enforcing one shared byte budget. */
export async function prepareRequestImages(request, signal, { vision = true } = {}) {
  let messages = request.messages;
  if (vision && hasImageUrls(messages)) {
    messages = await resolveImagesToInline(messages, signal);
  }
  if (inlineImageBytes(messages) > MAX_INLINE_IMAGE_BYTES) {
    throw inferenceError(413, "payload_too_large");
  }
  messages = fallbackUnreadImages(messages);
  return {
    ...request,
    messages,
    system: hasInlineImages(messages) ? request.system : stripVisionSystemLine(request.system),
  };
}
