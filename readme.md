## MCP 能力说明（MySQL / HTTP / Redis / ES）

本项目在 Cursor 中通过 MCP 配置了一组后端基础能力，用于直接在对话中操作数据库、调用 HTTP 接口以及访问 Redis、Elasticsearch。

### 1. MySQL 系列 MCP

MySQL 访问能力由 **`xx-mysql-mcp.js`** 提供，不同业务库（如 SCRM、Cashbox、SE 等）会在 `mcp.json` 中配置为不同的 MCP 实例。

> 这些 MCP 一般会提供诸如 `query`、`update` 等工具（具体名称视各自工具定义），可以在对话中直接执行 SQL。

- **典型使用场景**：
  - 查询业务表数据（如用户、租户、订单、账户余额等）；
  - 联调接口时，用 SQL 校验接口前后的数据变化；
  - 排查线上 / 测试环境业务异常（例如余额不一致、状态不正确）。

- **使用要点**：
  - 严禁在没有确认的情况下执行 **删库 / 大批量更新**；
  - 优先使用只读查询（`SELECT`），修改类操作前建议先导出/记录关键数据；
  - 注意环境区分（测试库 vs 生产库），本项目默认连接测试 / 开发环境。

### 2. HTTP MCP（http-mcp）

HTTP 能力由 **`http-mcp.js`** 提供，实现了一个通用的 HTTP 代理工具 `fetch`：

- **工具名**：`fetch`
- **主要入参**：
  - `url`：请求 URL，例如 `http://192.168.1.6:10003/wscrm-bus-api/lite/register`
  - `method`：`GET` / `POST` / `PUT` / `DELETE`
  - `body`：JSON 请求体对象（会对敏感字段做 AES 加密）
  - `headers`：可选，自定义 HTTP 头
  - `bearerToken`：可选，如传入则自动加上 `Authorization: Bearer <token>`

- **敏感字段自动加密**：
  - 任何 key 中包含 `password`、`pass`、`pwd`、`withdraw` 的字段，会走 AES-128-CBC 加密（密钥在 `http-mcp.js` 内部配置）。
  - 适合在调试对外/对内服务时保护密码等敏感信息。

- **典型使用场景**：
  - 调用业务 HTTP 接口（如注册、登录、余额查询等）；
  - 搭配 MySQL / Redis 校验接口前后数据一致性；
  - 搭配 Apifox/Postman 的接口文档进行自动化验证。

### 3. Redis MCP（user-scrm-redis-dev）

**user-scrm-redis-dev** MCP 提供了对 SCRM Redis 集群的访问，当前已定义的工具：

- `redis_get`：根据 key 获取值  
- `redis_set`：设置指定 key 的值  
- `redis_del`：删除指定 key

> 工具 JSON 描述位于 `.cursor/projects/.../mcps/user-scrm-redis-dev/tools/*.json`。

- **典型使用场景**：
  - 查询公司/账号相关缓存，例如：`bus:r_b:<tenantId>`；
  - 手动设置或清理某些业务缓存进行联调；
  - 排查缓存与数据库不一致问题。

- **示例**：
  - 查询公司 533464 的某业务缓存：
    - Key：`bus:r_b:533464`
    - 通过 `redis_get` 返回值 `2000`。

- **使用要点**：
  - 修改 / 删除缓存前，确认当前环境和业务影响范围；
  - 尽量通过业务接口触发缓存刷新，直接 `set/del` 只用于联调或应急。

### 4. Elasticsearch MCP（elasticsearch-mcp）

Elasticsearch 能力由 **`elasticsearch-mcp.js`** 提供，用于访问 ES 集群。

- **可能提供的能力**（以工具定义为准）：
  - 通过索引、DSL 查询日志或业务文档；
  - 分析错误日志、接口调用情况、搜索行为等。

- **典型使用场景**：
  - 联调接口或排查问题时，通过 ES 查询错误日志与慢查询；
  - 根据用户行为日志做简单统计或验证埋点。

- **使用要点**：
  - 明确索引名与时间范围，避免在超大索引上做无约束扫描；
  - 尽量使用 `query + filter + time range` 组合，减少资源消耗。

### 5. 文件系统 MCP（user-filesystem）

**user-filesystem** MCP 使用 `@modelcontextprotocol/server-filesystem`，指向目录：

- `D://workspace//java//cashbox`

- **用途**：
  - 在对话中直接读取 / 浏览 `cashbox` Java 项目代码；
  - 帮助进行代码分析、Bug 排查、接口/SQL/配置查找。

### 6. 建议的协同使用流程示例

以「注册 + 登录 + 校验缓存」为例：

1. **HTTP（http-mcp）**  
   - 调用注册接口 `/wscrm-bus-api/lite/register`，新建账号；
   - 调用登录接口 `/wscrm-bus-api/account/login`，获取 `tenant.id`、`isPlg` 等信息。
2. **Redis（user-scrm-redis-dev 或对应 redis-mcp 实例）**  
   - 使用 `redis_get` 查询 `bus:r_b:<tenantId>`，确认缓存是否写入，以及数值是否正确。
3. **MySQL（通过 `xx-mysql-mcp.js` 在 mcp.json 中配置的各业务库实例）**  
   - 根据 `tenant.id`、`account.id` 查询数据库，核对注册/登录写入的数据；
   - 校验余额或配额类字段与缓存是否一致。
4. **Elasticsearch（elasticsearch-mcp）**（可选）  
   - 如出现异常或错误码，查询 ES 日志定位问题。

通过以上 MCP 能力，可以在 Cursor 对话内完成「接口调用 → DB 校验 → 缓存校验 → 日志分析」的完整闭环联调。

