import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import * as openai from "@earendil-works/pi-ai/api/openai-responses";
import * as anthropic from "@earendil-works/pi-ai/api/anthropic-messages";
import * as codex from "@earendil-works/pi-ai/api/openai-codex-responses";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import type { Model } from "@earendil-works/pi-ai";

export function createMobileModels(
  getKey: (provider: string) => Promise<string | null>,
  fetcher: typeof fetch,
  getCodexToken?: (signal?: AbortSignal) => Promise<string | null>,
) {
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const auth = (provider: string) => ({
    apiKey: {
      name: `${provider} API key`,
      resolve: async () => {
        const apiKey = await getKey(provider);
        if (!apiKey)
          throw new Error(`Configure a ${provider} API key in Settings`);
        return { auth: { apiKey } };
      },
    },
  });
  models.setProvider(
    createProvider({
      id: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      auth: auth("openai"),
      models: Object.values(OPENAI_MODELS),
      api: {
        stream: (model, context, options) =>
          openai.stream(model as Model<"openai-responses">, context, {
            ...options,
            fetch: fetcher,
          }),
        streamSimple: (model, context, options) =>
          openai.streamSimple(model as Model<"openai-responses">, context, {
            ...options,
            fetch: fetcher,
          }),
      },
    }),
  );
  models.setProvider(
    createProvider({
      id: "anthropic",
      name: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      auth: auth("anthropic"),
      models: Object.values(ANTHROPIC_MODELS),
      api: {
        stream: (model, context, options) =>
          anthropic.stream(model as Model<"anthropic-messages">, context, {
            ...options,
            fetch: fetcher,
          }),
        streamSimple: (model, context, options) =>
          anthropic.streamSimple(
            model as Model<"anthropic-messages">,
            context,
            { ...options, fetch: fetcher },
          ),
      },
    }),
  );
  models.setProvider(
    createProvider({
      id: "openai-codex",
      name: "ChatGPT subscription (Codex)",
      baseUrl: "https://chatgpt.com/backend-api",
      models: Object.values(OPENAI_CODEX_MODELS),
      auth: {
        apiKey: {
          name: "ChatGPT subscription",
          resolve: async ({ signal }) => {
            const apiKey = await getCodexToken?.(signal);
            if (!apiKey)
              throw new Error("Sign in to ChatGPT with a device code first");
            return { auth: { apiKey } };
          },
        },
      },
      api: {
        stream: (model, context, options) =>
          codex.stream(model as Model<"openai-codex-responses">, context, {
            ...options,
            fetch: fetcher,
            transport: "sse",
            headers: {
              ...options?.headers,
              originator: "moose",
              "User-Agent": "Moose (React Native; Pi)",
            },
          }),
        streamSimple: (model, context, options) =>
          codex.streamSimple(
            model as Model<"openai-codex-responses">,
            context,
            {
              ...options,
              fetch: fetcher,
              transport: "sse",
              headers: {
                ...options?.headers,
                originator: "moose",
                "User-Agent": "Moose (React Native; Pi)",
              },
            },
          ),
      },
    }),
  );
  return models;
}
