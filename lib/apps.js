/** Server-owned app metadata. Store environment variable names here, never secrets. */
const registry = {
  trendingnostr: {
    name: "TrendingNostr",
    enabled: true,
    authSecretEnv: "TRENDINGNOSTR_APP_SECRET",
    defaultProvider: "replit",
    providers: {
      ollama: {
        enabled: true, model: "gemma4:cloud",
        apiKeyEnv: "TRENDINGNOSTR_OLLAMA_API_KEY", modelEnv: "TRENDINGNOSTR_OLLAMA_MODEL",
      },
      gemini: {
        enabled: true, model: "gemma-4-31b-it",
        apiKeyEnv: "TRENDINGNOSTR_GEMINI_API_KEY", modelEnv: "TRENDINGNOSTR_GEMINI_MODEL",
      },
      replit: {
        enabled: true, model: "google/gemma-4-26b-a4b-it",
        apiKeyEnv: "TRENDINGNOSTR_REPLIT_API_KEY", modelEnv: "TRENDINGNOSTR_REPLIT_MODEL",
        maxTokensEnv: "TRENDINGNOSTR_REPLIT_MAX_TOKENS",
      },
    },
  },
  advancednostrsearch: {
    name: "AdvancedNostrSearch",
    enabled: true,
    authSecretEnv: "ADVANCEDNOSTRSEARCH_APP_SECRET",
    defaultProvider: "replit",
    providers: {
      ollama: {
        enabled: true, model: "gemma4:cloud",
        apiKeyEnv: "ADVANCEDNOSTRSEARCH_OLLAMA_API_KEY", modelEnv: "ADVANCEDNOSTRSEARCH_OLLAMA_MODEL",
      },
      gemini: {
        enabled: true, model: "gemma-4-31b-it",
        apiKeyEnv: "ADVANCEDNOSTRSEARCH_GEMINI_API_KEY", modelEnv: "ADVANCEDNOSTRSEARCH_GEMINI_MODEL",
      },
      replit: {
        enabled: true, model: "google/gemma-4-26b-a4b-it",
        apiKeyEnv: "ADVANCEDNOSTRSEARCH_REPLIT_API_KEY", modelEnv: "ADVANCEDNOSTRSEARCH_REPLIT_MODEL",
        maxTokensEnv: "ADVANCEDNOSTRSEARCH_REPLIT_MAX_TOKENS",
      },
    },
  },
};

function freeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") freeze(child);
  }
  return Object.freeze(value);
}

export const apps = freeze(registry);

export function getApp(id) {
  return typeof id === "string" && Object.hasOwn(apps, id) ? apps[id] : undefined;
}

/** Include newly registered app settings in the local-only env loader. */
export function appEnvNames() {
  return Object.values(apps).flatMap((app) => [app.authSecretEnv,
    ...Object.values(app.providers).flatMap((provider) =>
      [provider.apiKeyEnv, provider.modelEnv, provider.maxTokensEnv].filter(Boolean)),
  ]);
}
