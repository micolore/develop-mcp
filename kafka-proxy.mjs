import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as Mcp from "@modelcontextprotocol/sdk/types.js";
import { Kafka } from "kafkajs";

// 1. 初始化 Kafka 客户端
const kafka = new Kafka({
  clientId: 'mcp-kafka-proxy',
  brokers: ['192.168.1.4:9092', '192.168.1.4:9093', '192.168.1.4:9094'],
  connectionTimeout: 10000, // 增加到 10s 应对内网延迟
});
const admin = kafka.admin();

const server = new Server({
  name: "kafka-manager",
  version: "1.0.0",
}, {
  capabilities: { tools: {} }
});

// 2. 注册工具定义
server.setRequestHandler(Mcp.ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_topics",
      description: "列出 Kafka 集群中所有 Topic",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "list_groups",
      description: "列出 Kafka 集群中所有的消费组 (Consumer Groups)",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "get_consumer_lag",
      description: "获取指定消费组在特定 Topic 上的积压情况 (Lag)",
      inputSchema: {
        type: "object",
        properties: {
          groupId: { type: "string", description: "消费组 ID" },
          topic: { type: "string", description: "Topic 名称" }
        },
        required: ["groupId", "topic"]
      }
    },
    {
      name: "peek_messages",
      description: "实时获取指定 Topic 最新产生的 N 条消息",
      inputSchema: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Topic 名称" },
          count: { type: "number", description: "获取的消息条数 (默认 5)", default: 5 }
        },
        required: ["topic"]
      }
    }
  ]
}));

// 3. 处理工具调用逻辑
server.setRequestHandler(Mcp.CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    await admin.connect();

    if (name === "list_topics") {
      const topics = await admin.listTopics();
      return { content: [{ type: "text", text: `集群 Topics: ${topics.join(', ')}` }] };
    }

    if (name === "list_groups") {
      const { groups } = await admin.listGroups();
      const groupIds = groups.map(g => `${g.groupId} (${g.protocolType})`);
      return { content: [{ type: "text", text: `集群消费组列表:\n${groupIds.join('\n')}` }] };
    }

    if (name === "get_consumer_lag") {
      const { groupId, topic } = args;
      // 修正 API：获取 Topic 的 High Watermark (最新位移)
      const topicOffsets = await admin.fetchTopicOffsets(topic);
      
      // 修正 API：获取消费组提交的位移
      const groupOffsets = await admin.fetchOffsets({ groupId, topics: [topic] });
      const topicData = groupOffsets.find(t => t.topic === topic);

      const lagDetails = topicOffsets.map(tp => {
        const partitionData = topicData ? topicData.partitions.find(p => p.partition === tp.partition) : null;
        const latest = parseInt(tp.offset);
        // 如果 offset 是 -1，表示该组从未在该分区提交过位移
        const current = (partitionData && partitionData.offset !== '-1') ? parseInt(partitionData.offset) : 0;
        const lag = Math.max(0, latest - current);
        
        return { partition: tp.partition, latestOffset: latest, currentOffset: current, lag };
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            groupId,
            topic,
            totalLag: lagDetails.reduce((s, p) => s + p.lag, 0),
            details: lagDetails
          }, null, 2)
        }]
      };
    }

    if (name === "peek_messages") {
      const consumer = kafka.consumer({ groupId: `mcp-peek-${Date.now()}` });
      await consumer.connect();
      await consumer.subscribe({ topic: args.topic, fromBeginning: false });

      const messages = [];
      return new Promise((resolve) => {
        const timeout = setTimeout(async () => {
          await consumer.disconnect();
          resolve({ content: [{ type: "text", text: messages.length ? JSON.stringify(messages, null, 2) : "3.5秒内未监听到新消息" }] });
        }, 3500);

        consumer.run({
          eachMessage: async ({ message }) => {
            messages.push({ 
              offset: message.offset, 
              value: message.value.toString(), 
              ts: new Date(parseInt(message.timestamp)).toLocaleString() 
            });
            if (messages.length >= (args.count || 5)) {
              clearTimeout(timeout);
              await consumer.disconnect();
              resolve({ content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] });
            }
          },
        }).catch(err => resolve({ isError: true, content: [{ type: "text", text: err.message }] }));
      });
    }

    return { isError: true, content: [{ type: "text", text: `未知工具: ${name}` }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: `Kafka 错误: ${e.message}` }] };
  } finally {
    // 只有 peek 模式需要特殊处理连接，其他模式正常 disconnect
    if (name !== "peek_messages") {
      try { await admin.disconnect(); } catch (e) {}
    }
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Kafka MCP Proy (V4-Full) 已启动并修复 Lag 逻辑");
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
