export const PROVIDER_CONFIG = {
  ollama: { keyEnv: "OLLAMA_API_KEY", modelEnv: "OLLAMA_MODEL", defaultModel: "gemma4:cloud" },
  gemini: { keyEnv: "GEMINI_API_KEY", modelEnv: "GEMINI_MODEL", defaultModel: "gemma-4-31b-it" },
  replit: { keyEnv: "REPLIT_API_KEY", modelEnv: "REPLIT_MODEL", defaultModel: "google/gemma-4-26b-a4b-it" },
};
