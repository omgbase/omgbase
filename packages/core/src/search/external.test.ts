import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { createExternalProvider, embedderEnv } from "./external.js";

const FAKE = fileURLToPath(new URL("../../test/fixtures/fake-embedder.mjs", import.meta.url));

describe("createExternalProvider — stdio", () => {
  it("spawns the command, handshakes model/dim, and embeds over stdio", async () => {
    const ext = await createExternalProvider({ provider: `node ${FAKE}` });
    expect(ext).not.toBeNull();
    try {
      expect(ext!.provider.model).toBe("fake-8");
      expect(ext!.provider.dim).toBe(8);
      const vecs = await ext!.provider.embed(["hello world", "hello world", "totally different tokens here"]);
      expect(vecs).toHaveLength(3);
      expect(vecs[0]).toHaveLength(8);
      // identical inputs → identical vectors
      expect(vecs[0]).toEqual(vecs[1]);
      // normalized ⇒ unit length
      const norm = Math.sqrt(vecs[0]!.reduce((s, x) => s + x * x, 0));
      expect(norm).toBeCloseTo(1, 5);
    } finally {
      await ext!.close();
    }
  });

  it("embed([]) returns [] without round-tripping", async () => {
    const ext = await createExternalProvider({ provider: `node ${FAKE}` });
    try {
      expect(await ext!.provider.embed([])).toEqual([]);
    } finally {
      await ext!.close();
    }
  });

  it("throws a clear error when the command cannot spawn", async () => {
    await expect(createExternalProvider({ provider: "this-command-does-not-exist-omg" })).rejects.toThrow(/spawn|exited/i);
  });

  it("returns null when no provider is configured", async () => {
    expect(await createExternalProvider({})).toBeNull();
  });

  it("forwards embedding.model to the spawned command as OMGBASE_EMBEDDER_MODEL (the fake echoes it in its handshake)", async () => {
    const ext = await createExternalProvider({ provider: `node ${FAKE}`, model: "from-settings" });
    try {
      expect(ext!.provider.model).toBe("from-settings");
    } finally {
      await ext!.close();
    }
  });
});

describe("embedderEnv (settings → OMGBASE_EMBEDDER_* env)", () => {
  it("explicit settings win over an inherited variable; unset settings leave the env alone", () => {
    const base = { PATH: "/bin", OMGBASE_EMBEDDER_MODEL: "ambient", OMGBASE_EMBEDDER_DIM: "1" };
    const env = embedderEnv({ provider: "x", model: "explicit", maxInputTokens: 256 }, base);
    expect(env.PATH).toBe("/bin");
    expect(env.OMGBASE_EMBEDDER_MODEL).toBe("explicit");
    expect(env.OMGBASE_EMBEDDER_DIM).toBe("1"); // not set in settings → inherited
    expect(env.OMGBASE_EMBEDDER_MAX_TOKENS).toBe("256");
  });

  it("stringifies dim and sets nothing when no settings are given", () => {
    expect(embedderEnv({ provider: "x", dim: 384 }, {}).OMGBASE_EMBEDDER_DIM).toBe("384");
    expect(embedderEnv({ provider: "x" }, { A: "1" })).toEqual({ A: "1" });
  });
});

describe("createExternalProvider — http", () => {
  it("reads metadata via GET and embeds via POST", async () => {
    const server: Server = createServer((req, res) => {
      if (req.method === "GET") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ model: "http-4", dim: 4 }));
        return;
      }
      // POST → echo a fixed vector per text
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { texts } = JSON.parse(body) as { texts: string[] };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ vectors: texts.map(() => [1, 0, 0, 0]) }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    try {
      const ext = await createExternalProvider({ provider: `http://127.0.0.1:${port}/embed` });
      expect(ext!.provider.model).toBe("http-4");
      expect(ext!.provider.dim).toBe(4);
      const vecs = await ext!.provider.embed(["a", "b"]);
      expect(vecs).toEqual([[1, 0, 0, 0], [1, 0, 0, 0]]);
      await ext!.close();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
