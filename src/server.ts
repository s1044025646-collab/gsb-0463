import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { Service } from "./service.js";
import { LambdaError } from "./core.js";

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new LambdaError("LIMIT_EXCEEDED", "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new LambdaError("INVALID_JSON", "request body is not valid JSON");
  }
}

export function startServer(service: Service, port: number, maxBodyBytes = 1024 * 1024): Promise<{ port: number; close: () => void }> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body = method === "POST" ? await readBody(req, maxBodyBytes) : null;
      const b = (body ?? {}) as Record<string, unknown>;

      if (method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

      if (method === "POST" && url.pathname === "/terms")
        return send(res, 201, service.importTerm((b ).term));

      if (parts[0] === "terms" && parts.length === 2 && method === "GET")
        return send(res, 200, service.getTerm(Number(parts[1])));

      if (parts[0] === "terms" && parts[2] === "free-variables" && method === "GET")
        return send(res, 200, service.freeVariables(Number(parts[1])));

      if (method === "POST" && url.pathname === "/substitute") {
        const r = service.substitute(b.body, b.var as string, b.arg);
        return send(res, 200, r);
      }

      if (method === "POST" && url.pathname === "/alpha-equivalent")
        return send(res, 200, service.alphaEquivalent((b ).a, (b ).b));

      if (method === "POST" && url.pathname === "/reductions")
        return send(res, 201, service.createReduction(b as { termId?: number; term?: unknown; budget: unknown }));

      if (parts[0] === "reductions" && parts.length === 2 && method === "GET") {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 1000);
        return send(res, 200, service.getReduction(Number(parts[1]), offset, limit));
      }

      if (parts[0] === "reductions" && parts[2] === "step" && method === "POST") {
        const expected = b && "expectedStepIndex" in b ? Number((b ).expectedStepIndex) : undefined;
        return send(res, 200, service.step(Number(parts[1]), expected));
      }

      if (parts[0] === "reductions" && parts[2] === "export" && method === "GET")
        return send(res, 200, service.getReduction(Number(parts[1]), 0, 100000));

      return send(res, 404, { error: { code: "NOT_FOUND", message: "unknown route" } });
    } catch (e) {
      if (e instanceof LambdaError) {
        const status =
          e.code.endsWith("NOT_FOUND") ? 404 :
          e.code === "LIMIT_EXCEEDED" ? 413 :
          e.code.startsWith("INVALID") || e.code === "STEP_INDEX_MISMATCH" ? 400 : 409;
        return send(res, status, { error: { code: e.code, message: e.message } });
      }
      return send(res, 500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}
