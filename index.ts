import { Type } from "@sinclair/typebox";

interface Mem0Config {
  baseUrl: string;
  userId: string;
  autoCapture: boolean;
  autoRecall: boolean;
  recallLimit: number;
  recallThreshold: number;
}

interface Memory {
  id: string;
  memory: string;
  score?: number;
  metadata?: Record<string, any>;
}

interface SearchResponse {
  memories: Memory[];
}

interface AddResponse {
  success: boolean;
  result: {
    results: Array<{
      id: string;
      memory: string;
      event: string;
    }>;
  };
}

const configSchema = {
  parse(value: unknown): Mem0Config {
    const v = (value as any) || {};
    return {
      baseUrl: v.baseUrl || "http://127.0.0.1:8420",
      userId: v.userId || "openclaw",
      autoCapture: v.autoCapture !== false,
      autoRecall: v.autoRecall !== false,
      recallLimit: v.recallLimit || 5,
      recallThreshold: v.recallThreshold || 0.4,
    };
  },
};

class Mem0Client {
  private config: Mem0Config;
  private healthChecked = false;

  constructor(config: Mem0Config) {
    this.config = config;
  }

  async ensureHealthy(): Promise<void> {
    if (this.healthChecked) return;

    try {
      const response = await fetch(`${this.config.baseUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        console.warn(`[memory-mem0] Health check failed: ${response.status}`);
      } else {
        const data = await response.json();
        console.log(`[memory-mem0] Connected to Mem0 server: ${data.status}`);
      }
      this.healthChecked = true;
    } catch (error) {
      console.warn(`[memory-mem0] Could not connect to Mem0 server:`, error);
    }
  }

  async search(query: string, limit?: number): Promise<Memory[]> {
    await this.ensureHealthy();

    const params = new URLSearchParams({
      query,
      user_id: this.config.userId,
      limit: String(limit || this.config.recallLimit),
    });

    try {
      const response = await fetch(
        `${this.config.baseUrl}/memories/search?${params}`,
        {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        }
      );

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const data: SearchResponse = await response.json();
      return data.memories || [];
    } catch (error) {
      console.error("[memory-mem0] Search error:", error);
      return [];
    }
  }

  async add(content: string, agentId?: string): Promise<AddResponse | null> {
    await this.ensureHealthy();

    const body = {
      content,
      user_id: this.config.userId,
      metadata: agentId ? { agent_id: agentId } : undefined,
    };

    try {
      const response = await fetch(`${this.config.baseUrl}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Add failed: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      console.error("[memory-mem0] Add error:", error);
      return null;
    }
  }

  async list(): Promise<Memory[]> {
    await this.ensureHealthy();

    const params = new URLSearchParams({
      user_id: this.config.userId,
    });

    try {
      const response = await fetch(
        `${this.config.baseUrl}/memories?${params}`,
        {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        }
      );

      if (!response.ok) {
        throw new Error(`List failed: ${response.statusText}`);
      }

      const data: SearchResponse = await response.json();
      return data.memories || [];
    } catch (error) {
      console.error("[memory-mem0] List error:", error);
      return [];
    }
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureHealthy();

    try {
      const response = await fetch(`${this.config.baseUrl}/memories/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        throw new Error(`Delete failed: ${response.statusText}`);
      }

      return true;
    } catch (error) {
      console.error("[memory-mem0] Delete error:", error);
      return false;
    }
  }
}

export default {
  id: "memory-mem0",
  name: "Mem0 Memory",
  description:
    "Long-term semantic memory via a self-hosted Mem0 REST API",
  kind: "memory" as const,
  configSchema,

  register(api: any) {
    const config = configSchema.parse(api.pluginConfig);
    const client = new Mem0Client(config);

    // Tool: memory_recall
    api.registerTool(
      {
        name: "memory_recall",
        label: "Recall Memory",
        description: "Search long-term memory for relevant facts and context",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(
            Type.Number({
              description: "Maximum number of results (default 5)",
              minimum: 1,
              maximum: 20,
            })
          ),
        }),
        async execute(
          toolCallId: string,
          params: { query: string; limit?: number }
        ) {
          const memories = await client.search(params.query, params.limit);

          if (memories.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `No relevant memories found for: "${params.query}"`,
                },
              ],
            };
          }

          const formatted = memories
            .map((m, i) => {
              const score =
                m.score !== undefined
                  ? ` (relevance: ${m.score.toFixed(2)})`
                  : "";
              return `${i + 1}. ${m.memory}${score}`;
            })
            .join("\n");

          return {
            content: [
              {
                type: "text" as const,
                text: `Found ${memories.length} relevant memories:\n\n${formatted}`,
              },
            ],
          };
        },
      },
      { name: "memory_recall" }
    );

    // Tool: memory_store
    api.registerTool(
      {
        name: "memory_store",
        label: "Store Memory",
        description: "Store a new fact or context in long-term memory",
        parameters: Type.Object({
          content: Type.String({
            description: "Fact or context to remember",
          }),
          agent_id: Type.Optional(
            Type.String({ description: "Agent ID for metadata (optional)" })
          ),
        }),
        async execute(
          toolCallId: string,
          params: { content: string; agent_id?: string }
        ) {
          const result = await client.add(params.content, params.agent_id);

          if (!result || !result.success) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Failed to store memory.",
                },
              ],
            };
          }

          const stored = result.result.results.map((r) => r.memory).join(", ");
          return {
            content: [
              {
                type: "text" as const,
                text: `Stored in memory: ${stored}`,
              },
            ],
          };
        },
      },
      { name: "memory_store" }
    );

    // Tool: memory_forget
    api.registerTool(
      {
        name: "memory_forget",
        label: "Forget Memory",
        description: "Delete a specific memory by ID",
        parameters: Type.Object({
          id: Type.String({ description: "Memory ID to delete" }),
        }),
        async execute(toolCallId: string, params: { id: string }) {
          const success = await client.delete(params.id);

          return {
            content: [
              {
                type: "text" as const,
                text: success
                  ? `Deleted memory: ${params.id}`
                  : `Failed to delete memory: ${params.id}`,
              },
            ],
          };
        },
      },
      { name: "memory_forget" }
    );

    // CLI: mem0 commands (search, list, forget)
    api.registerCli(
      ({ program }: any) => {
        const mem0 = program
          .command("mem0")
          .description("Mem0 memory plugin commands");

        mem0
          .command("search")
          .description("Search long-term memory")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", "5")
          .action(async (query: string, opts: any) => {
            const memories = await client.search(
              query,
              parseInt(opts.limit)
            );
            if (memories.length === 0) {
              console.log(`No memories found for: "${query}"`);
              return;
            }
            console.log(`\nFound ${memories.length} memories:\n`);
            memories.forEach((m, i) => {
              const score =
                m.score !== undefined ? ` [${m.score.toFixed(2)}]` : "";
              console.log(`${i + 1}. ${m.memory}${score}`);
              console.log(`   ID: ${m.id}\n`);
            });
          });

        mem0
          .command("list")
          .description("List all stored memories")
          .action(async () => {
            const memories = await client.list();
            if (memories.length === 0) {
              console.log("No memories stored yet.");
              return;
            }
            console.log(`\nTotal memories: ${memories.length}\n`);
            memories.forEach((m, i) => {
              console.log(`${i + 1}. ${m.memory}`);
              console.log(`   ID: ${m.id}\n`);
            });
          });

        mem0
          .command("forget")
          .description("Delete a memory by ID")
          .argument("<id>", "Memory ID to delete")
          .action(async (id: string) => {
            const success = await client.delete(id);
            console.log(
              success ? `Deleted: ${id}` : `Failed to delete: ${id}`
            );
          });
      },
      { commands: ["mem0"] }
    );

    // Auto-recall: inject relevant memories before agent starts
    if (config.autoRecall) {
      api.on("before_agent_start", async (event: any) => {
        const prompt = event.prompt || "";
        if (!prompt.trim()) return;

        const memories = await client.search(prompt, config.recallLimit);
        const relevant = memories.filter(
          (m) => (m.score || 0) >= config.recallThreshold
        );

        if (relevant.length === 0) return;

        const formatted = relevant
          .map((m) => `- ${m.memory} [score: ${m.score?.toFixed(2)}]`)
          .join("\n");

        return {
          prependContext: `<relevant-memories>\nRelevant facts from long-term memory:\n${formatted}\n</relevant-memories>`,
        };
      });
    }

    // Auto-capture: store key facts after agent completes
    if (config.autoCapture) {
      api.on("agent_end", async (event: any) => {
        const messages = event.messages || [];

        for (const msg of messages) {
          if (msg.role === "user" || msg.role === "assistant") {
            const text = msg.content || "";

            // Skip recalled memory context to prevent feedback loops
            if (text.includes("<relevant-memories>")) continue;

            // Only capture substantial messages
            if (text.trim().length < 50) continue;

            await client.add(text, event.agentId);
          }
        }
      });
    }

    console.log(
      `[memory-mem0] Plugin registered (autoRecall=${config.autoRecall}, autoCapture=${config.autoCapture})`
    );
  },
};
