export const TEST_APP_SECRET = "private-test-app-secret";

export function appHeaders(providerKey = "test-key", appId = "trendingnostr", secret = TEST_APP_SECRET) {
  return {
    "x-inference-app": appId,
    authorization: `Bearer ${secret}`,
    "x-inference-provider-key": providerKey,
  };
}
