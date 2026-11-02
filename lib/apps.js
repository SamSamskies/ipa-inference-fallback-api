/** Server-owned app metadata. Store environment variable names here, never secrets. */
const registry = {
  trendingnostr: {
    name: "TrendingNostr",
    enabled: true,
    authSecretEnv: "TRENDINGNOSTR_APP_SECRET",
    defaultProvider: "replit",
    providers: {
      ollama: {
        enabled: true,
        apiKeyEnv: "TRENDINGNOSTR_OLLAMA_API_KEY",
      },
      gemini: {
        enabled: true,
        apiKeyEnv: "TRENDINGNOSTR_GEMINI_API_KEY",
      },
      replit: {
        enabled: true,
        apiKeyEnv: "TRENDINGNOSTR_REPLIT_API_KEY",
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
        enabled: true,
        apiKeyEnv: "ADVANCEDNOSTRSEARCH_OLLAMA_API_KEY",
      },
      gemini: {
        enabled: true,
        apiKeyEnv: "ADVANCEDNOSTRSEARCH_GEMINI_API_KEY",
      },
      replit: {
        enabled: true,
        apiKeyEnv: "ADVANCEDNOSTRSEARCH_REPLIT_API_KEY",
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
      [provider.apiKeyEnv, provider.maxTokensEnv].filter(Boolean)),
  ]);
}
