const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { Client } = require('@elastic/elasticsearch');
const fs = require('fs');

// --- 错误捕获 ---
process.on('uncaughtException', (err) => {
  fs.appendFileSync('D:/mcp_error.log', `[${new Date()}] 运行时错误: ${err.stack}\n`);
});

// --- 1. 初始化 ES 客户端 ---
// 修复：如果没密码，不要传 auth 字段
const clientOptions = {
  node: [
    'http://192.168.1.4:9100',
    'http://192.168.1.4:9101',
    'http://192.168.1.4:9102'
  ],
  enableMetaHeader: false, 
  auth: undefined
};

// 只有当环境变量中有账号密码时才添加 auth
if (process.env.ES_USERNAME && process.env.ES_PASSWORD) {
  clientOptions.auth = {
    username: process.env.ES_USERNAME,
    password: process.env.ES_PASSWORD
  };
}
const client = new Client(clientOptions);

// --- 2. 创建 MCP Server ---
const server = new Server(
  { name: "es-enhanced-server", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

// --- 3. 注册工具列表 (必须在 connect 之前) ---
server.setRequestHandler(ListToolsRequestSchema, async () => {
  // 打印调试信息到文件（不要 console.log）
  fs.appendFileSync('D:/mcp_debug.txt', `[${new Date()}] Cursor 正在请求工具列表...\n`);
  
  return {
    tools: [
      {
        name: "list_indices",
        description: "列出集群中所有的 Elasticsearch 索引信息。",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
      },
      {
        name: "get_index_mapping",
        description: "获取特定索引的字段映射（Schema）。",
        inputSchema: {
          type: "object",
          properties: { index: { type: "string" } },
          required: ["index"]
        }
      },
      {
        name: "query_es_logs",
        description: "执行 ES DSL 查询。",
        inputSchema: {
          type: "object",
          properties: {
            index: { type: "string" },
            query: { type: "object", description: "ES Query DSL 对象" }
          },
          required: ["index", "query"]
        }
      }
    ]
  };
});

// --- 4. 处理工具调用 ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "list_indices":
        const indices = await client.cat.indices({ format: 'json', h: 'index,status,health,docs.count,store.size' });
        return { content: [{ type: "text", text: JSON.stringify(indices) }] };
      case "get_index_mapping":
        const mapping = await client.indices.getMapping({ index: args.index });
        return { content: [{ type: "text", text: JSON.stringify(mapping) }] };
      case "query_es_logs":
        const result = await client.search({ index: args.index, body: args.query });
        return { content: [{ type: "text", text: JSON.stringify(result.hits.hits) }] };
      default:
        throw new Error(`未知工具: ${name}`);
    }
  } catch (error) {
    return { content: [{ type: "text", text: `操作失败: ${error.message}` }], isError: true };
  }
});

// --- 5. 启动服务 ---
const transport = new StdioServerTransport();
server.connect(transport).catch(err => {
  fs.appendFileSync('D:/mcp_error.log', `[${new Date()}] 连接失败: ${err.stack}\n`);
});
