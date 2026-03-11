const axios = require("axios");
const crypto = require("crypto");

// 配置信息
const AES_KEY = "618e8fe93b3e79b8";
const AES_IV = AES_KEY;
const SENSITIVE_KEYWORDS = ["password", "pass", "pwd", "withdraw"];

/**
 * AES 加密函数
 */
function aesEncrypt(text) {
  try {
    if (!text) return text;
    const cipher = crypto.createCipheriv(
      "aes-128-cbc",
      Buffer.from(AES_KEY),
      Buffer.from(AES_IV),
    );
    let encrypted = cipher.update(String(text), "utf8", "base64");
    return encrypted + cipher.final("base64");
  } catch (e) {
    process.stderr.write(`[AES ERROR] ${e.message}\n`);
    return text;
  }
}

/**
 * 递归加密逻辑：对包含敏感字段名的 key 进行 AES 加密
 */
function encryptPayload(obj) {
  if (typeof obj !== "object" || obj === null) return;

  for (let key in obj) {
    const lowerKey = key.toLowerCase();
    const shouldEncrypt = SENSITIVE_KEYWORDS.some((word) =>
      lowerKey.includes(word),
    );

    if (
      shouldEncrypt &&
      (typeof obj[key] === "string" || typeof obj[key] === "number")
    ) {
      process.stderr.write(`[SECURE] Encrypting field: ${key}\n`);
      obj[key] = aesEncrypt(obj[key]);
    } else if (typeof obj[key] === "object") {
      encryptPayload(obj[key]);
    }
  }
}

/**
 * 标准 MCP 响应封装
 * result 为 JSON-RPC result 字段内容
 */
function sendResponse(id, result) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n",
  );
}

/**
 * 解决 Cursor 升级后的“粘包”问题：按行读取 JSON-RPC 请求
 */
let buffer = "";

process.stdin.on("data", async (chunk) => {
  buffer += chunk.toString();
  let lines = buffer.split("\n");
  buffer = lines.pop(); // 剩下的不完整部分留到下次

  for (let line of lines) {
    if (!line.trim()) continue;

    try {
      const request = JSON.parse(line);

      const { id, method, params } = request;

      // 1. 初始化握手
      if (method === "initialize") {
        const clientProtocol =
          params?.protocolVersion || "2025-11-25"; // 与客户端版本尽量保持一致

        sendResponse(id, {
          protocolVersion: clientProtocol,
          capabilities: {
            tools: {
              // 关键字段：声明支持 tools 能力，Cursor 才会调用 tools/list
              listChanged: false,
            },
            logging: {},
          },
          serverInfo: {
            name: "secure-http-proxy",
            version: "2.2.0",
          },
        });
      }

      // 2. 工具列表定义（支持 headers / bearerToken）
      else if (method === "tools/list") {
        sendResponse(id, {
          tools: [
            {
              name: "fetch",
              description:
                "发送带有敏感字段 AES 加密的 HTTP 请求，支持自定义请求头与 Bearer 认证",
              inputSchema: {
                type: "object",
                properties: {
                  url: {
                    type: "string",
                    description: "请求 URL",
                  },
                  method: {
                    type: "string",
                    enum: ["GET", "POST", "PUT", "DELETE"],
                  },
                  body: {
                    type: "object",
                    description: "JSON 请求体（会对敏感字段进行 AES 加密）",
                  },
                  headers: {
                    type: "object",
                    description:
                      '可选，自定义请求头。例如: { "Authorization": "Bearer <token>", "Accept": "application/json" }',
                  },
                  bearerToken: {
                    type: "string",
                    description:
                      "可选，Bearer Token。设置后会自动添加请求头 Authorization: Bearer <token>",
                  },
                },
                required: ["url", "method", "body"],
                additionalProperties: false,
              },
            },
          ],
        });
      }

      // 3. 执行工具调用
      else if (method === "tools/call") {
        const toolName = params?.name;
        const args = params?.arguments || {};

        if (toolName !== "fetch") {
          sendResponse(id, {
            content: [
              {
                type: "text",
                text: `未知工具: ${toolName}`,
              },
            ],
            isError: true,
          });
          continue;
        }

        const { url, method: httpMethod, body, headers: customHeaders, bearerToken } =
          args;

        process.stderr.write(`[HTTP] Calling: ${httpMethod} ${url}\n`);

        // 兼容 body 为字符串的情况（Cursor 有时会传 stringified JSON）
        let payload = body;
        if (typeof payload === "string") {
          try {
            payload = JSON.parse(payload);
          } catch (e) {
            process.stderr.write(
              `[WARN] body 不是合法 JSON 字符串，将按空对象处理: ${e.message}\n`,
            );
            payload = {};
          }
        }

        payload = JSON.parse(JSON.stringify(payload || {})); // 深拷贝一份，避免副作用
        encryptPayload(payload);

        // 合并请求头：默认 Content-Type，再合并自定义 headers，bearerToken 优先设置 Authorization
        const headers = {
          "Content-Type": "application/json",
          ...(customHeaders && typeof customHeaders === "object"
            ? customHeaders
            : {}),
        };

        if (bearerToken != null && String(bearerToken).trim() !== "") {
          headers["Authorization"] = "Bearer " + String(bearerToken).trim();
        }

        try {
          const res = await axios({
            url,
            method: httpMethod || "POST",
            data: payload,
            timeout: 10000,
            headers,
          });

          sendResponse(id, {
            content: [
              {
                type: "text",
                text: JSON.stringify(res.data),
              },
            ],
          });
        } catch (err) {
          const errorMsg = err.response
            ? JSON.stringify(err.response.data)
            : err.message;

          sendResponse(id, {
            content: [
              {
                type: "text",
                text: `API Error: ${errorMsg}`,
              },
            ],
            isError: true,
          });
        }
      }

      // 4. 其他/未知方法（可按需扩展）
      else {
        sendResponse(id, {
          content: [
            {
              type: "text",
              text: `Unknown method: ${method}`,
            },
          ],
          isError: true,
        });
      }
    } catch (e) {
      process.stderr.write(`[CRITICAL] Parse Error: ${e.message}\n`);
    }
  }
});
