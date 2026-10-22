import type { AgentToolResult, ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { getArtifactMetadata, readArtifact, storeArtifact } from "../artifacts/store.ts";

const parameters = Type.Object({
  action: Type.Union([Type.Literal("create"), Type.Literal("metadata"), Type.Literal("read")], {
    description: "Create a bounded upload artifact, inspect metadata, or read one bounded content window.",
  }),
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Opaque artifact ID returned by a job, upload, or download (metadata/read)." })),
  data: Type.Optional(Type.String({ maxLength: 1_398_104, description: "Upload data (create; at most 1 MiB after decoding)." })),
  kind: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Artifact kind (create), e.g. upload." })),
  contentType: Type.Optional(Type.String({ maxLength: 160, description: "Declared upload MIME type (create)." })),
  dataEncoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")], { description: "Input encoding for create; base64 must be canonical." })),
  offset: Type.Optional(Type.Number({ minimum: 0, description: "Byte cursor; use nextOffset from the preceding read." })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 262144, description: "Maximum bytes returned, at most 256 KiB." })),
  encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")], {
    description: "Read encoding. Binary artifacts default to base64; UTF-8 windows align to scalar boundaries and may include up to 3 extra bytes to ensure cursor progress.",
  })),
}, { additionalProperties: false });

type ArtifactParams = Static<typeof parameters>;
const TEXT_CONTENT_TYPE = /^(?:text\/|application\/(?:json|xml|[^;]+\+json|[^;]+\+xml))/i;

function asDetails(value: object): AgentToolResult["details"] {
  return value as unknown as AgentToolResult["details"];
}

const artifactsTool: ToolDefinition<typeof parameters> = {
  name: "cyber_artifacts",
  label: "Cyber artifacts",
  description:
    "Create a private engagement-scoped upload artifact (≤1 MiB), inspect metadata, or read an explicit bounded content window. " +
    "References are opaque, content is integrity-checked with SHA-256, and binary reads use base64 by default.",
  promptSnippet:
    "Use cyber_artifacts create for explicit small uploads, or pass an opaque artifact ID from a job/browser/HTTP workflow. Read bounded windows with offset/nextOffset; use base64 for exact binary bytes.",
  parameters,
  executionMode: "sequential",
  annotations: { readOnlyHint: false, openWorldHint: false },
  async execute(
    _toolCallId: string,
    params: ArtifactParams,
    _signal: AbortSignal | undefined,
    _onUpdate,
    _ctx: ExtensionToolContext,
  ): Promise<AgentToolResult> {
    if (params.action === "create") {
      if (params.data === undefined) throw new Error("data required for the create action.");
      if (params.kind === undefined) throw new Error("kind required for the create action.");
      const dataEncoding = params.dataEncoding ?? "utf8";
      let data: string | Uint8Array;
      if (dataEncoding === "base64") {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(params.data)) {
          throw new Error("base64 data must use canonical padded encoding.");
        }
        const decoded = Buffer.from(params.data, "base64");
        if (decoded.toString("base64") !== params.data) throw new Error("base64 data must use canonical padded encoding.");
        if (decoded.byteLength > 1024 * 1024) throw new Error("upload artifact exceeds the 1 MiB limit.");
        data = decoded;
      } else {
        if (Buffer.byteLength(params.data, "utf8") > 1024 * 1024) throw new Error("upload artifact exceeds the 1 MiB limit.");
        data = params.data;
      }
      const artifact = storeArtifact(data, {
        kind: params.kind,
        ...(params.contentType !== undefined ? { contentType: params.contentType } : {}),
      });
      return {
        content: [{ type: "text", text: `artifact ${artifact.id} created · ${artifact.kind} · ${artifact.contentType} · ${artifact.bytes} bytes · sha256:${artifact.sha256}` }],
        details: asDetails({ action: "create", artifact }),
      };
    }

    if (!params.id) throw new Error(`id required for the ${params.action} action.`);

    if (params.action === "metadata") {
      const artifact = getArtifactMetadata(params.id);
      return {
        content: [{ type: "text", text: `artifact ${artifact.id} · ${artifact.kind} · ${artifact.contentType} · ${artifact.bytes} bytes · sha256:${artifact.sha256} · created=${artifact.createdAt}` }],
        details: asDetails({ action: "metadata", artifact }),
      };
    }

    const metadata = getArtifactMetadata(params.id);
    const encoding = params.encoding ?? (TEXT_CONTENT_TYPE.test(metadata.contentType) ? "utf8" : "base64");
    const result = readArtifact(params.id, {
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      encoding,
    });
    return {
      content: [{ type: "text", text: result.data }],
      details: asDetails({
        action: "read",
        artifact: result.artifact,
        offset: result.offset,
        nextOffset: result.nextOffset,
        encoding,
      }),
    };
  },
};

export function registerArtifactsTool(pi: Pick<ExtensionAPI, "registerTool">): void {
  pi.registerTool(artifactsTool);
}
