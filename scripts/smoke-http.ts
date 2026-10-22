import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBypassFetchTool } from "../src/tools/bypass-fetch.ts";
import { readArtifact, storeArtifact } from "../src/artifacts/store.ts";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "cyber-http-smoke-"));
process.env.CYBER_EVIDENCE_DIR = root;
process.env.CYBER_ENGAGEMENT_ID = "smoke";
const bytes = Buffer.from([0, 255, 128, 13, 10, 65]);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === "/echo") return new Response(await req.arrayBuffer(), {headers:{"Content-Type":"application/octet-stream"}});
  if (url.pathname === "/form") {
    const form = await req.formData();
    const file = form.get("upload");
    const correct = file instanceof File && Buffer.from(await file.arrayBuffer()).equals(bytes)
      && file.name === "fixture.bin" && form.get("label") === "literal @field; value";
    return Response.json({ correct });
  }
  if (url.pathname === "/redirect") return new Response(null, {status:302, headers:{Location:"/bytes?token=fixture"}});
  return new Response(bytes, {headers:{"Content-Type":"application/octet-stream","Set-Cookie":"fixture=yes"}});
}});
let tool: ToolDefinition | undefined;
registerBypassFetchTool({registerTool(definition) {tool = definition as ToolDefinition;}} as Parameters<typeof registerBypassFetchTool>[0]);
const context = {sessionManager:{getBranch:()=>[]}} as unknown as ExtensionToolContext;
async function request(path: string, params: object) {
  return await tool!.execute("http-smoke", {url:`http://127.0.0.1:${server.port}${path}`,timeoutSec:10,...params} as never, undefined, undefined, context);
}
try {
  const upload = storeArtifact(bytes, {kind:"http-smoke-upload"});
  const echo = await request("/echo", {method:"POST",bodyArtifact:upload.id,responseMode:"artifact"});
  const echoMeta = echo.details as {responseArtifact?: {id:string}};
  if (!echoMeta.responseArtifact) throw new Error("response artifact was not exposed");
  const echoed = readArtifact(echoMeta.responseArtifact.id, {encoding:"base64"});
  if (!Buffer.from(echoed.data,"base64").equals(bytes)) throw new Error("binary bytes changed");
  const form = await request("/form", {method:"POST",multipart:{fields:{label:"literal @field; value"},files:[{field:"upload",artifactId:upload.id,filename:"fixture.bin",contentType:"application/octet-stream"}]}});
  const formText = form.content.map((item) => item.type === "text" ? item.text : "").join("\n");
  if (!formText.includes('"correct":true')) throw new Error("multipart bytes or literal field value changed");
  const redirect = await request("/redirect", {method:"GET",responseMode:"artifact"});
  const metadata = redirect.details as {responseHeaders?:Array<{name:string;value:string}>;redirects?:unknown[]};
  if (!metadata.redirects || metadata.redirects.length < 2) throw new Error("redirect provenance missing");
  if (metadata.responseHeaders?.some((h)=>h.name.toLowerCase()==="set-cookie" && h.value!=="[redacted]")) throw new Error("cookie header was exposed");
  console.log("PASS: actual HTTP binary upload/response round trip, multipart literal fields/file bytes, redirect provenance, redacted headers");
} finally {
  server.stop(true);
  rmSync(root,{recursive:true,force:true});
}
