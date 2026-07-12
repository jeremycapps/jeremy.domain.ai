import http from "node:http";
import { handleGenerateResume, buildErrorResponse } from "./routes/generateResume.js";
import { buildCapabilityErrorResponse, handleCapabilityAnalysis, handleCapabilityReadiness } from "./routes/capabilityAnalysis.js";

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createServer() {
  return http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");

    if (request.method === "GET" && request.url === "/health") {
      response.statusCode = 200;
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/api/capability-analysis/readiness")) {
      const url = new URL(request.url, "http://localhost");
      const result = handleCapabilityReadiness(url.searchParams.get("mode") ?? "live");
      response.statusCode = 200;
      response.end(JSON.stringify(result, null, 2));
      return;
    }

    if (request.method === "POST" && request.url === "/api/capability-analysis") {
      try {
        const body = await readJsonBody(request);
        const result = await handleCapabilityAnalysis(body);
        response.statusCode = 200;
        response.end(JSON.stringify(result, null, 2));
      } catch (error) {
        const errorResponse = buildCapabilityErrorResponse(error);
        response.statusCode = errorResponse.statusCode;
        response.end(JSON.stringify(errorResponse.body, null, 2));
      }
      return;
    }

    if (request.method !== "POST" || request.url !== "/api/generate-resume") {
      response.statusCode = 404;
      response.end(JSON.stringify({ status: "error", error: { message: "Not found." } }));
      return;
    }

    try {
      const body = await readJsonBody(request);
      const result = await handleGenerateResume(body);
      response.statusCode = 200;
      response.end(JSON.stringify(result, null, 2));
    } catch (error) {
      const errorResponse = buildErrorResponse(error);
      response.statusCode = errorResponse.statusCode;
      response.end(JSON.stringify(errorResponse.body, null, 2));
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  createServer().listen(port, () => {
    console.log(`Resume router backend listening on http://localhost:${port}`);
  });
}
