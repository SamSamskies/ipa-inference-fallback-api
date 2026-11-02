/** Server-owned app metadata. Store environment variable names here, never secrets. */
const registry = {
  trendingnostr: {
    name: "TrendingNostr",
    enabled: true,
    authSecretEnv: "TRENDINGNOSTR_APP_SECRET",
    providers: {
      ollama: {
        enabled: true,
      },
      gemini: {
        enabled: true,
      },
      replit: {
        enabled: true,
        maxTokensEnv: "TRENDINGNOSTR_REPLIT_MAX_TOKENS",
      },
    },
  },
  advancednostrsearch: {
    name: "AdvancedNostrSearch",
    enabled: true,
    authSecretEnv: "ADVANCEDNOSTRSEARCH_APP_SECRET",
    providers: {
      ollama: {
        enabled: true,
      },
      gemini: {
        enabled: true,
      },
      replit: {
        enabled: true,
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
      [provider.maxTokensEnv].filter(Boolean)),
  ]);
}
