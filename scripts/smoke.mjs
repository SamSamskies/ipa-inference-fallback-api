import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import handler from "../api/inference.js";

const HELP = `Usage: npm run smoke -- [--provider ollama|gemini] [--model MODEL] [--url ENDPOINT]

By default, start a temporary local server using keys from .env.local.
Omit --provider to use DEFAULT_INFERENCE_PROVIDER (otherwise ollama).
Use --model to override the selected provider's model for this local run only.
Use --url to test an existing /api/inference endpoint with its own server keys.
--model cannot be combined with --url; remote models are configured server-side.
Runs a configuration probe and a short generation with web search disabled.
`;

async function startLocalServer() {
  const server = createServer(async (req, res) => {
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (value) => res.end(JSON.stringify(value));
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      req.body = Buffer.concat(chunks).toString("utf8");
      await handler(req, res);
    } catch {
      res.status(500).json({ error: "local_server_error" });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function request(url, init, provider, local) {
  const response = await fetch(url, init);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${init.method} returned HTTP ${response.status} without a JSON response.`);
  }
  if (!response.ok) {
    // Only print known endpoint error codes, never raw provider errors or keys.
    const code = typeof body?.error === "string" && /^[a-z_]+$/.test(body.error)
      ? body.error : "unexpected_error";
    const hint = code === "missing_api_key" && local
      ? ` Set ${provider.toUpperCase()}_API_KEY in .env.local.` : "";
    const retryAfter = response.headers.get("retry-after");
    const retry = retryAfter && /^\d+$/.test(retryAfter) ? ` Retry after ${retryAfter}s.` : "";
    throw new Error(`${init.method} returned HTTP ${response.status}: ${code}.${hint}${retry}`);
  }
  return body;
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      provider: { type: "string" }, model: { type: "string" },
      url: { type: "string" }, help: { type: "boolean", short: "h" },
    } }));
  } catch {
    throw new Error("Invalid arguments. Use npm run smoke -- --help for usage.");
  }
  if (values.help) {
    console.log(HELP);
    return;
  }
  const provider = values.provider !== undefined
    ? values.provider.trim().toLowerCase()
    : process.env.DEFAULT_INFERENCE_PROVIDER?.trim().toLowerCase() || "ollama";
  if ((values.provider !== undefined || values.url === undefined) &&
    provider !== "ollama" && provider !== "gemini") {
    throw new Error("Choose --provider ollama or --provider gemini.");
  }
  if (values.model !== undefined) {
    if (!values.model.trim()) throw new Error("--model must be nonempty.");
    if (values.url !== undefined) {
      throw new Error("--model is only available for local smoke tests; --url uses the server's configured model.");
    }
    process.env[provider === "ollama" ? "OLLAMA_MODEL" : "GEMINI_MODEL"] = values.model.trim();
  }

  let server;
  try {
    let url;
    if (values.url !== undefined) {
      try {
        url = new URL(values.url);
      } catch {
        throw new Error("--url must be an absolute HTTP(S) endpoint URL.");
      }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("--url must be an HTTP(S) endpoint URL without embedded credentials.");
      }
    } else {
      server = await startLocalServer();
      url = new URL(`http://127.0.0.1:${server.address().port}/api/inference`);
    }
    if (values.provider !== undefined) url.searchParams.set("provider", provider);

    const signal = AbortSignal.timeout(60_000);
    const started = Date.now();
    const probe = await request(url, { method: "GET", signal }, provider, Boolean(server));
    if (probe?.ok !== true) throw new Error("GET returned an invalid configuration probe.");
    console.log("Configuration probe passed.");

    const result = await request(url, {
      method: "POST", signal,
      headers: {
        "Content-Type": "application/json",
        Origin: url.origin,
        "X-Inference-Client": randomUUID(),
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Reply with exactly: smoke test OK" }],
        webSearch: false,
        options: { reasoningEffort: "none", temperature: 0 },
      }),
    }, provider, Boolean(server));
    if (typeof result?.content !== "string" || !result.content.trim() ||
      typeof result.model !== "string" || !result.model.trim()) {
      throw new Error("POST returned an invalid inference response; expected nonempty content and model.");
    }
    console.log(`Smoke test passed (${Date.now() - started}ms).`);
    console.log(`Model: ${result.model}`);
    console.log(`Response: ${result.content.trim()}`);
  } finally {
    if (server) {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
  }
}

main().catch((error) => {
  const message = error?.name === "TimeoutError" ? "Request timed out after 60 seconds."
    : error?.message === "fetch failed" ? "Could not reach the endpoint. Check --url and whether its server is running."
      : error.message;
  console.error(`Smoke test failed: ${message}`);
  process.exitCode = 1;
});
