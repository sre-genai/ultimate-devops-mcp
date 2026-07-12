import { Kafka, logLevel, type Admin } from "kafkajs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig, KafkaConfig } from "../config.js";
import { jsonResult, registerCloser, safe } from "../util.js";

let kafka: Kafka | undefined;
let admin: Admin | undefined;
let adminConnecting: Promise<Admin> | undefined;

function getKafka(cfg: KafkaConfig): Kafka {
  if (!kafka) {
    kafka = new Kafka({
      clientId: cfg.clientId,
      brokers: cfg.brokers,
      ssl: cfg.ssl || undefined,
      sasl:
        cfg.saslMechanism && cfg.saslUsername && cfg.saslPassword
          ? ({
              mechanism: cfg.saslMechanism,
              username: cfg.saslUsername,
              password: cfg.saslPassword,
            } as never)
          : undefined,
      logLevel: logLevel.NOTHING,
      connectionTimeout: 10_000,
      requestTimeout: 30_000,
    });
  }
  return kafka;
}

async function getAdmin(cfg: KafkaConfig): Promise<Admin> {
  if (admin) return admin;
  if (!adminConnecting) {
    const a = getKafka(cfg).admin();
    adminConnecting = a
      .connect()
      .then(() => {
        admin = a;
        registerCloser("kafka-admin", async () => {
          await admin?.disconnect();
          admin = undefined;
          adminConnecting = undefined;
        });
        return a;
      })
      .catch((err) => {
        adminConnecting = undefined;
        throw err;
      });
  }
  return adminConnecting;
}

export function registerKafka(server: McpServer, config: AppConfig): boolean {
  const cfg = config.integrations.kafka;
  if (!cfg) return false;

  server.registerTool(
    "kafka_list_topics",
    {
      title: "List Kafka topics",
      description: "Lists all topics in the cluster.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe("kafka_list_topics", async () => {
      const topics = await (await getAdmin(cfg)).listTopics();
      return jsonResult(topics.sort());
    }),
  );

  server.registerTool(
    "kafka_describe_topic",
    {
      title: "Describe Kafka topic",
      description: "Returns partition layout, leaders, and current low/high watermarks (message offsets) for a topic.",
      inputSchema: {
        topic: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("kafka_describe_topic", async ({ topic }) => {
      const a = await getAdmin(cfg);
      const [meta, offsets] = await Promise.all([
        a.fetchTopicMetadata({ topics: [topic] }),
        a.fetchTopicOffsets(topic),
      ]);
      const t = meta.topics[0];
      return jsonResult({
        name: t.name,
        partitions: t.partitions.map((p) => {
          const off = offsets.find((o) => o.partition === p.partitionId);
          return {
            partition: p.partitionId,
            leader: p.leader,
            replicas: p.replicas,
            isr: p.isr,
            lowOffset: off?.low,
            highOffset: off?.high,
          };
        }),
      });
    }),
  );

  server.registerTool(
    "kafka_consumer_groups",
    {
      title: "List Kafka consumer groups",
      description: "Lists consumer groups with their state and member counts.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe("kafka_consumer_groups", async () => {
      const a = await getAdmin(cfg);
      const { groups } = await a.listGroups();
      const ids = groups.map((g) => g.groupId).slice(0, 100);
      if (ids.length === 0) return jsonResult([]);
      const described = await a.describeGroups(ids);
      return jsonResult(
        described.groups.map((g) => ({
          groupId: g.groupId,
          state: g.state,
          protocolType: g.protocolType,
          members: g.members.length,
        })),
      );
    }),
  );

  server.registerTool(
    "kafka_consumer_lag",
    {
      title: "Kafka consumer group lag",
      description:
        "Computes per-partition lag for a consumer group: high watermark minus committed offset for every topic the group consumes.",
      inputSchema: {
        groupId: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    safe("kafka_consumer_lag", async ({ groupId }) => {
      const a = await getAdmin(cfg);
      const committed = await a.fetchOffsets({ groupId });
      const results: Array<{
        topic: string;
        partition: number;
        committedOffset: string;
        highWatermark: string;
        lag: number | null;
      }> = [];
      let totalLag = 0;
      for (const t of committed) {
        const watermarks = await a.fetchTopicOffsets(t.topic);
        for (const p of t.partitions) {
          const hw = watermarks.find((w) => w.partition === p.partition);
          const committedN = Number(p.offset);
          const highN = Number(hw?.high ?? "0");
          const lag = p.offset === "-1" || !hw ? null : Math.max(0, highN - committedN);
          if (lag !== null) totalLag += lag;
          results.push({
            topic: t.topic,
            partition: p.partition,
            committedOffset: p.offset,
            highWatermark: hw?.high ?? "unknown",
            lag,
          });
        }
      }
      return jsonResult({ groupId, totalLag, partitions: results });
    }),
  );

  server.registerTool(
    "kafka_tail",
    {
      title: "Tail Kafka topic",
      description:
        "Reads the most recent N messages from a topic (peek — uses a throwaway consumer group that is deleted afterwards). Bounded by count and timeout.",
      inputSchema: {
        topic: z.string(),
        count: z.number().int().min(1).max(100).optional().describe("Messages to fetch (default 10)"),
        timeoutMs: z.number().int().min(1000).max(30_000).optional().describe("Max wait (default 10000)"),
      },
      annotations: { readOnlyHint: true },
    },
    safe("kafka_tail", async ({ topic, count, timeoutMs }) => {
      const max = count ?? 10;
      const deadline = timeoutMs ?? 10_000;
      const a = await getAdmin(cfg);
      const groupId = `mcp-tail-${randomUUID()}`;

      const offsets = await a.fetchTopicOffsets(topic);
      const consumer = getKafka(cfg).consumer({ groupId });
      const messages: Array<Record<string, unknown>> = [];

      try {
        await consumer.connect();
        await consumer.subscribe({ topic, fromBeginning: true });

        const done = new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, deadline);
          void consumer.run({
            eachMessage: async ({ partition, message }) => {
              messages.push({
                partition,
                offset: message.offset,
                timestamp: message.timestamp,
                key: message.key?.toString("utf8") ?? null,
                value: message.value?.toString("utf8").slice(0, 4000) ?? null,
                headers: Object.fromEntries(
                  Object.entries(message.headers ?? {}).map(([k, v]) => [k, v?.toString() ?? null]),
                ),
              });
              if (messages.length >= max) {
                clearTimeout(timer);
                resolve();
              }
            },
          });
          // Seek each partition to (high - perPartitionBudget) so we read the tail, not the head.
          const perPartition = Math.max(1, Math.ceil(max / offsets.length));
          for (const o of offsets) {
            const target = Math.max(Number(o.low), Number(o.high) - perPartition);
            consumer.seek({ topic, partition: o.partition, offset: String(target) });
          }
        });
        await done;
      } finally {
        await consumer.disconnect().catch(() => {});
        await a.deleteGroups([groupId]).catch(() => {});
      }

      messages.sort((m1, m2) => Number(m1.timestamp) - Number(m2.timestamp));
      return jsonResult({ topic, returned: messages.length, messages: messages.slice(-max) });
    }),
  );

  if (config.allowWrites) {
    server.registerTool(
      "kafka_produce",
      {
        title: "Produce Kafka message (write)",
        description: "Sends a message to a topic. Enabled because MCP_ALLOW_WRITES=true.",
        inputSchema: {
          topic: z.string(),
          value: z.string().describe("Message value (string; JSON-encode objects yourself)"),
          key: z.string().optional(),
          headers: z.record(z.string()).optional(),
        },
        annotations: { destructiveHint: true },
      },
      safe("kafka_produce", async ({ topic, value, key, headers }) => {
        const producer = getKafka(cfg).producer();
        await producer.connect();
        try {
          const res = await producer.send({
            topic,
            messages: [{ value, key, headers }],
          });
          return jsonResult(res);
        } finally {
          await producer.disconnect().catch(() => {});
        }
      }),
    );
  }

  return true;
}
