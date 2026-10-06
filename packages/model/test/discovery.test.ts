import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authFilePath,
  clearAuthKey,
  discoverModels,
  loadAuth,
  maskKey,
  readLastUsed,
  recordLastUsed,
  resolveApiKey,
  saveAuthKey,
  saveProviderToUserFile,
  testProvider,
  userModelsFile,
} from "../src/discovery.js";

let savedHome: string | undefined;
let home: string;

beforeEach(() => {
  savedHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "kern-test-"));
  process.env.HOME = home;
  vi.unstubAllEnvs();
});

afterEach(() => {
  process.env.HOME = savedHome;
});

describe("maskKey", () => {
  it("keeps ! and $ references as-is", () => {
    expect(maskKey("!pass show key")).toBe("!pass show key");
    expect(maskKey("$OPENAI_API_KEY")).toBe("$OPENAI_API_KEY");
  });
  it("masks short literals", () => {
    expect(maskKey("short")).toBe("••••");
    expect(maskKey("12345678")).toBe("••••");
  });
  it("masks long literals sk-…abcd style", () => {
    expect(maskKey("sk-1234abcd")).toBe("sk-…abcd");
  });
});

describe("auth file", () => {
  it("authFilePath lives under ~/.kern", () => {
    expect(authFilePath()).toBe(join(home, ".kern", "auth.json"));
  });
  it("loadAuth returns {} when missing", async () => {
    await expect(loadAuth()).resolves.toEqual({});
  });
  it("save/load/clear roundtrip", async () => {
    await saveAuthKey("openai", "sk-test-key");
    await expect(loadAuth()).resolves.toEqual({ openai: { apiKey: "sk-test-key" } });
    await saveAuthKey("other", "k2");
    const both = await loadAuth();
    expect(Object.keys(both).sort()).toEqual(["openai", "other"]);
    await clearAuthKey("openai");
    await expect(loadAuth()).resolves.toEqual({ other: { apiKey: "k2" } });
    await clearAuthKey("missing");
    await expect(loadAuth()).resolves.toEqual({ other: { apiKey: "k2" } });
  });
});

describe("resolveApiKey precedence", () => {
  it("explicit > auth.json > config literal > env", async () => {
    process.env.PREC_TEST_ENV = "env-key";
    await saveAuthKey("prec-p", "auth-key");
    const cfg = { baseUrl: "https://example.com/v1", apiKey: "literal-key", apiKeyEnv: "PREC_TEST_ENV" } as const;
    expect(await resolveApiKey("prec-p", { ...cfg }, "explicit-key")).toBe("explicit-key");
    expect(await resolveApiKey("prec-p", { ...cfg })).toBe("auth-key");
    expect(await resolveApiKey("prec-other", { ...cfg })).toBe("literal-key");
    expect(await resolveApiKey("prec-env", { baseUrl: "https://example.com/v1", apiKeyEnv: "PREC_TEST_ENV" })).toBe(
      "env-key",
    );
    expect(await resolveApiKey("prec-loop", { baseUrl: "http://localhost:11434/v1" })).toBeUndefined();
  });
});

describe("saveProviderToUserFile", () => {
  it("rejects bad names and urls", async () => {
    await expect(saveProviderToUserFile("Bad Name!", { baseUrl: "http://localhost:11434/v1" })).rejects.toThrow();
    await expect(saveProviderToUserFile("ok.name-1", { baseUrl: "ftp://x" })).rejects.toThrow();
  });
  it("accepts dots in names", async () => {
    const { path } = await saveProviderToUserFile("my.provider-1", { baseUrl: "http://localhost:11434/v1" });
    expect(path).toBe(userModelsFile());
  });
  it("never stores literal secrets in models.json", async () => {
    const { summary } = await saveProviderToUserFile(
      "cloud",
      { baseUrl: "https://example.com/v1", apiKey: "sk-secret-key-1234" },
      { makeDefault: true },
    );
    expect(summary).not.toContain("sk-secret-key-1234");
    const modelsRaw = await readFile(userModelsFile(), "utf8");
    expect(modelsRaw).not.toContain("sk-secret-key-1234");
    expect(JSON.parse(modelsRaw).defaultProvider).toBe("cloud");
    const auth = await loadAuth();
    expect(auth.cloud?.apiKey).toBe("sk-secret-key-1234");
  });
  it("keeps $VAR references in models.json", async () => {
    await saveProviderToUserFile("ref", { baseUrl: "https://example.com/v1", apiKey: "$REF_KEY" });
    const modelsRaw = await readFile(userModelsFile(), "utf8");
    expect(JSON.parse(modelsRaw).providers.ref.apiKey).toBe("$REF_KEY");
  });
});

describe("last used", () => {
  it("returns null when missing, roundtrips after record", async () => {
    await expect(readLastUsed()).resolves.toBeNull();
    await recordLastUsed("ollama", "llama3");
    await expect(readLastUsed()).resolves.toEqual({ provider: "ollama", model: "llama3" });
  });
});

function stubFetch(handler: (url: string) => unknown) {
  return ((_url: unknown, _init?: unknown) => Promise.resolve(handler(String(_url)))) as unknown as typeof fetch;
}

describe("testProvider", () => {
  it("rejects non-http urls", async () => {
    const r = await testProvider("ftp://x", undefined);
    expect(r.ok).toBe(false);
  });
  it("maps connection refused to friendly message", async () => {
    const r = await testProvider(
      "http://localhost:9/v1",
      undefined,
      { fetchImpl: stubFetch(() => { throw new Error("connect ECONNREFUSED 127.0.0.1:9"); }) },
    );
    expect(r).toEqual({ ok: false, message: expect.stringContaining("Is the server running?") });
  });
  it("maps 401 to key rejected", async () => {
    const r = await testProvider(
      "https://example.com/v1",
      "bad",
      { fetchImpl: stubFetch(() => ({ ok: false, status: 401, json: async () => ({}) })) },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("Key rejected");
  });
  it("maps timeouts with proxy hint", async () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    const r = await testProvider("https://example.com/v1", "k", { fetchImpl: stubFetch(() => { throw err; }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("proxy");
  });
  it("flags empty model lists with manual-id hint", async () => {
    const r = await testProvider(
      "https://example.com/v1",
      "k",
      { fetchImpl: stubFetch(() => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("manually");
  });
  it("returns models on success", async () => {
    const r = await testProvider(
      "https://example.com/v1",
      "k",
      { fetchImpl: stubFetch(() => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "a" }] }) })) },
    );
    expect(r).toEqual({ ok: true, models: ["a"] });
  });
});

describe("discoverModels filtering", () => {
  const live = stubFetch(() => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] }) }));
  const file = {
    providers: {
      p: {
        baseUrl: "http://localhost:9999/v1",
        models: [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
      },
    },
  };
  it("whitelist narrows then blacklist removes, for configured and live", async () => {
    const out = await discoverModels(
      { providers: { p: { ...file.providers.p, whitelist: ["m1", "m2"], blacklist: ["m2"] } } },
      { provider: "p" },
      { fetchImpl: live },
    );
    const configured = out.filter((m) => m.source === "configured").map((m) => m.id);
    expect(configured).toEqual(["m1"]);
    expect(out.filter((m) => m.source === "live").map((m) => m.id)).toEqual([]);
  });
  it("no filters returns union without dupes", async () => {
    const out = await discoverModels(file, { provider: "p" }, { fetchImpl: live });
    expect(out.map((m) => m.id).sort()).toEqual(["m1", "m2", "m3"]);
  });
});
