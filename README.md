# LoopForge 基础服务：登录、菜品资料与图片

在身份、会话与角色鉴权底座上提供菜品资料和单图片管理。当前版本不包含每日菜单、订单或员工下单业务。

技术栈：Node.js 22、TypeScript 5、Fastify 5、PostgreSQL 14+（本地 Compose 使用 PostgreSQL 16）、私有 S3 兼容对象存储（本地 Compose 使用 MinIO）、`pg` 参数化 SQL、Pino 结构化日志、OIDC 授权码登录。

## 目录与分层

```text
src/
  http/                 接口层：路由、参数校验入口、鉴权钩子、统一错误映射
  domain/               领域层：认证、菜品校验/状态流转、图片编排与解码子进程池
  ports/                领域端口：身份、菜品、图片对象存储、菜单可见性、图片解码
  db/                   数据访问层：pg Pool、身份/菜品 Repository、迁移器、种子
  storage/              私有对象存储适配器：S3 与测试内存实现
  composition/          唯一依赖装配点：端口与 PostgreSQL/S3 实现绑定
  sso/                  OIDC 客户端与 dev/test 内嵌 Mock IdP
  config.ts             配置加载与启动前校验
  logger.ts             安全结构化日志与运行时脱敏
  errors.ts             稳定错误码与统一错误信封
migrations/             顺序迁移 SQL（001 身份、002 登录尝试、003 菜品）
test/                   配置、迁移、认证、菜品、图片与故障恢复测试
```

接口层不直接执行 SQL；身份、菜品和图片元数据的读写集中在数据访问层；图片字节只经 `ImageObjectStore` 写入私有桶。认证与 401/403 判定由领域用例完成，HTTP 只读取 Cookie、调用用例并形成响应；错误信封和 trace 由共享基础模块统一处理。

## 前置条件

- Node.js 22 与 npm
- Docker 与 Docker Compose（或自备 PostgreSQL 14+）
- 可访问 npm registry 与容器镜像仓库

## 本地启动（30 分钟内）

```bash
cp .env.example .env
# 编辑 .env：设置数据库密码、SESSION_SECRET、MinIO 管理员和对象存储应用凭据
npm ci
docker compose up -d db minio minio-init
npm run migrate
npm run seed:dev
npm run dev
```

生成 `SESSION_SECRET`：

```bash
openssl rand -base64 48
```

`.env` 建议值（本地 Mock SSO）：

```dotenv
APP_ENV=dev
PORT=8080
POSTGRES_PASSWORD=<本地开发数据库密码>
DATABASE_URL=postgres://loopforge:<同一密码>@localhost:5432/loopforge
SSO_MODE=mock
SESSION_SECRET=<上一步生成的值>
SESSION_TTL_SECONDS=28800
SESSION_COOKIE_NAME=loopforge_session
POST_LOGIN_REDIRECT_URL=/api/v1/auth/me
LOG_LEVEL=info
HEALTH_DB_TIMEOUT_MS=2000
MOCK_SSO_PORT=9090
MOCK_SSO_HOST=127.0.0.1
MOCK_SSO_ISSUER=http://localhost:9090
OBJECT_STORAGE_DRIVER=s3
OBJECT_STORAGE_ENDPOINT=http://localhost:9000
OBJECT_STORAGE_REGION=us-east-1
OBJECT_STORAGE_BUCKET=loopforge-dish-images
OBJECT_STORAGE_ACCESS_KEY_ID=loopforge-app
OBJECT_STORAGE_SECRET_ACCESS_KEY=<MinIO 应用账号密码>
OBJECT_STORAGE_FORCE_PATH_STYLE=true
```

健康检查：

```bash
curl -i http://localhost:8080/healthz
# HTTP/1.1 200 OK
# {"status":"UP"}
```

也可以一次启动数据库、MinIO 与应用容器（容器内自动初始化私有桶、执行迁移与开发种子）：

```bash
docker compose up --build
```

## 配置项

启动时会校验全部配置。缺失或非法时进程在监听端口前以状态码 1 退出，只输出变量名，不输出配置值。

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `APP_ENV` | 是 | 无 | `dev`、`test`、`prod` |
| `PORT` | 否 | `8080` | 1–65535 |
| `DATABASE_URL` | 是 | 无 | `postgres://` 或 `postgresql://` 连接串，禁止写入日志 |
| `SSO_MODE` | 是 | 无 | `oidc` 或 `mock`；生产只允许 `oidc` |
| `SSO_ISSUER` | `oidc` 时是 | 无 | 绝对 http/https URL；生产必须 https |
| `SSO_CLIENT_ID` | `oidc` 时是 | 无 | OIDC client id |
| `SSO_CLIENT_SECRET` | `oidc` 时是 | 无 | 仅服务端使用，禁止输出 |
| `SSO_REDIRECT_URI` | `oidc` 时是 | 无 | 绝对回调 URL；生产必须 https |
| `SESSION_SECRET` | 是 | 无 | UTF-8 至少 32 字节，禁止输出 |
| `SESSION_TTL_SECONDS` | 否 | `28800` | 1–28800 秒 |
| `SESSION_COOKIE_NAME` | 否 | `loopforge_session` | `^[A-Za-z0-9_-]{1,64}$` |
| `POST_LOGIN_REDIRECT_URL` | 否 | `/api/v1/auth/me` | 仅站内绝对路径（单个 `/` 开头）；拒绝绝对 URL、`//`、反斜杠、fragment 与控制字符 |
| `LOG_LEVEL` | 否 | `info` | `error`、`warn`、`info`、`debug`；生产禁止 `debug` |
| `HEALTH_DB_TIMEOUT_MS` | 否 | `2000` | 1–10000 ms |
| `MOCK_SSO_PORT` | 否 | `9090` | 仅 mock 生效 |
| `MOCK_SSO_HOST` | 否 | `127.0.0.1` | 仅 mock 生效；Compose 使用 `0.0.0.0` 以接收端口映射流量 |
| `MOCK_SSO_ISSUER` | 否 | `http://localhost:9090` | 必须与 Mock 监听端口一致 |
| `OBJECT_STORAGE_DRIVER` | 是 | 无 | `s3` 或 `memory`；`memory` 只允许 `APP_ENV=test` |
| `OBJECT_STORAGE_ENDPOINT` | `s3` 时是 | 无 | 绝对 http/https URL；本地为 `http://localhost:9000` |
| `OBJECT_STORAGE_REGION` | `s3` 时是 | 无 | 小写区域名；本地 MinIO 为 `us-east-1` |
| `OBJECT_STORAGE_BUCKET` | `s3` 时是 | 无 | 预创建的私有桶；应用不自动建桶或改 ACL |
| `OBJECT_STORAGE_ACCESS_KEY_ID` | `s3` 时是 | 无 | 仅有 `dish-images/` 前缀读写删权限的应用账号 |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | `s3` 时是 | 无 | 仅服务端使用并参与日志脱敏 |
| `OBJECT_STORAGE_FORCE_PATH_STYLE` | `s3` 时是 | 无 | `true` 或 `false`；本地 MinIO 为 `true` |
| `SSO_NAME_CLAIM` | 否 | `name` | 身份 claim 名 |
| `SSO_ROLES_CLAIM` | 否 | `roles` | 角色 claim 名 |
| `SSO_ACCOUNT_STATUS_CLAIM` | 否 | `account_status` | 账号状态 claim 名 |
| `SSO_EMPLOYEE_NO_CLAIM` | 否 | `employee_no` | 员工号 claim 名 |
| `SSO_DEPARTMENT_CLAIM` | 否 | `department` | 部门 claim 名 |

`.env.example` 只含占位值。不要提交真实数据库密码、client secret、会话密钥或生产令牌。

### 私有图片存储

Compose 启动时，`minio-init` 幂等创建 `OBJECT_STORAGE_BUCKET`，关闭匿名访问，并只给应用账号授予 `dish-images/*` 的 `PutObject/GetObject/DeleteObject`。应用只返回 `/api/v1/dish-images/{image_id}`，不会暴露对象键或签名直链。

验证桶不是匿名可读（可在 MinIO 控制台上传一个临时对象后替换路径）：

```bash
docker compose exec minio-init mc anonymous get "local/${OBJECT_STORAGE_BUCKET}"
curl -i "http://localhost:9000/${OBJECT_STORAGE_BUCKET}/dish-images/probe"
# 期望非 200；私有桶不会直接返回对象内容
```

生产必须使用外部 S3 兼容存储、阻断公共访问、由密钥管理系统注入最小权限凭据。Compose 中的 MinIO 仅用于本地开发与真实存储集成测试。

## Mock SSO 与测试身份

Mock IdP 仅在 `dev`/`test` 运行，与应用同进程、默认监听 `127.0.0.1:9090`。它提供 discovery、JWKS、authorize、token 端点，使用进程内临时 RSA 密钥以 RS256 签发 ID Token；授权码一次性且 60 秒过期。登录适配器强制校验 ID Token 的签名、issuer、audience、`exp`、`iat` 和 nonce。生产环境使用 `SSO_MODE=mock` 会启动失败。

登录发起：

```bash
# 浏览器打开；缺省 login_hint=u-emp-001
浏览器打开 http://localhost:8080/api/v1/auth/login
浏览器打开 "http://localhost:8080/api/v1/auth/login?login_hint=u-admin-001"
```

| `login_hint` | 角色 | 预期 |
| --- | --- | --- |
| `u-emp-001` | `EMPLOYEE` | 登录成功；员工探针 200；管理探针 403 |
| `u-admin-001` | `MENU_ADMIN` | 登录成功；管理探针 200；员工探针 403 |
| `u-dual-001` | `EMPLOYEE` + `MENU_ADMIN` | 登录成功；两个探针均 200 |
| `u-disabled-001` | `EMPLOYEE`，`DISABLED` | 回调 403，不建立会话 |
| `u-norole-001` | 无已知角色 | 回调 403，不建立会话；新主体不写数据库 |
| `u-unknown-001` | `EMPLOYEE` + `SUPER_ADMIN` | 登录成功；仅持久化 `EMPLOYEE` |

`u-emp-001`、`u-admin-001`、`u-dual-001`、`u-disabled-001` 由 `npm run seed:dev` 预置；其余两个按上表行为生成。Mock 非法 `login_hint` 返回 `422 VALIDATION_ERROR`，且不创建登录尝试。

P-06 采用 A 方案：已有用户被 SSO 同步为零角色时，在同一事务内更新资料、清空旧角色并刷新 `synced_at`，随后返回 `403 FORBIDDEN` 且不建立新会话；该用户旧会话的下一次受保护请求也因零角色返回 `403`。新主体仍不写 `app_user`/`user_role`。

## 接口与权限

| 方法 | 路径 | 权限 | 成功 |
| --- | --- | --- | --- |
| `GET` | `/healthz` | 公开 | `200 {"status":"UP"}`；数据库不可用 `503` |
| `GET` | `/api/v1/auth/login` | 公开 | `302` 到 IdP，设置一次性 state Cookie |
| `GET` | `/api/v1/auth/callback` | 公开 | 成功后设置会话 Cookie 并 `302` 到 `POST_LOGIN_REDIRECT_URL` |
| `GET` | `/api/v1/auth/me` | 有效会话 + 至少一个已知角色 | 当前数据库用户 DTO |
| `GET` | `/api/v1/employee/auth-check` | `EMPLOYEE` | `200 {"allowed":true}` |
| `GET` | `/api/v1/admin/auth-check` | `MENU_ADMIN` | `200 {"allowed":true}` |
| `GET` | `/api/v1/admin/dishes` | `MENU_ADMIN` | `200 {"items":[DishDTO...]}` |
| `POST` | `/api/v1/admin/dishes` | `MENU_ADMIN` | `201 DishDTO`，新建固定下架 |
| `GET` | `/api/v1/admin/dishes/{dish_id}` | `MENU_ADMIN` | `200 DishDTO` |
| `PATCH` | `/api/v1/admin/dishes/{dish_id}` | `MENU_ADMIN` | `200 DishDTO`，编辑资料 |
| `PUT` | `/api/v1/admin/dishes/{dish_id}/sale_status` | `MENU_ADMIN` | `200 DishDTO` |
| `DELETE` | `/api/v1/admin/dishes/{dish_id}` | `MENU_ADMIN` | `204`；被引用时 `409 DISH_IN_USE` |
| `PUT` | `/api/v1/admin/dishes/{dish_id}/image` | `MENU_ADMIN` | `200 DishDTO`，上传或替换图片 |
| `DELETE` | `/api/v1/admin/dishes/{dish_id}/image` | `MENU_ADMIN` | `200 DishDTO`，移除后返回占位标识 |
| `GET` | `/api/v1/dish-images/{image_id}` | 有效会话；管理员全量，员工按菜单可见性 | `200` 原始图片字节 |
| `GET` | `/api/v1/test/business-error` | 仅 `APP_ENV=test` | `409 DEMO_CONFLICT` |
| `GET` | `/api/v1/test/uncaught-error` | 仅 `APP_ENV=test` | `500 INTERNAL_ERROR` |

未登录访问受保护接口返回 `401 UNAUTHENTICATED`；已登录但角色不足返回 `403 FORBIDDEN`；401 永远先于 403。会话 Cookie 为 HS256 JWT，Cookie 不含角色；每个受保护请求都会重新读取数据库中的账号状态和角色，因此停用或角色收窄在下一次请求立即生效。

菜品图片写接口对非管理员返回 `403 IMAGE_FORBIDDEN`，且鉴权发生在 multipart 解析前。图片仅接受实际可完整解码的 JPEG/PNG/WebP，单文件上限 5,242,880 字节；对象保存在私有桶，读取必须经过会话和可见性校验。

`reference_price_cents` 是 PostgreSQL `BIGINT` 人民币分，合法范围为 `1..9223372036854775807`。API 使用 JSON 数字令牌无损传输；客户端必须使用 `lossless-json`、BigInt 或原始 token 透传，禁止用原生 `JSON.parse` 后 `Number` 处理价格，否则超过 `9,007,199,254,740,991` 时会丢失精度。

所有错误响应均为 JSON，包含非空 `code`、`message`、`traceId`，并设置与响应体一致的 `X-Trace-Id`。401 额外包含 `loginUrl`；参数错误可包含字段级 `details`。未捕获异常只向客户端返回通用 `INTERNAL_ERROR`。

## 数据库迁移与种子

```bash
npm run migrate
npm run seed:dev
```

- 迁移文件必须使用三位数字版本前缀；迁移器按数值前缀排序，在 PostgreSQL advisory lock 下逐版本执行；非法或重复前缀会拒绝执行，已应用版本跳过，支持空库/已有库重复执行。
- `001_identity.sql` 创建 `app_user`、`user_role`；`002_login_attempt.sql` 创建一次性登录尝试表；`003_dish.sql` 创建菜品表、图片唯一索引和后台列表索引。
- 迁移不创建每日菜单、菜单菜品、订单、订单明细或独立图片历史表，也不修改已有用户数据。`daily_menu_item.dish_id`、`order_items.dish_id` 必须以 `VARCHAR(64) REFERENCES dish(dish_id) ON DELETE RESTRICT` 保护引用。
- `seed:dev` 只允许 `APP_ENV=dev` 或 `test`，单事务比对四个固定账号与角色集合，仅写入差异；重复执行不产生重复行、不会刷新未变化账号的 `synced_at`；生产直接拒绝。
- 应用启动不会自动迁移。生产发布必须先执行迁移，再启动应用。

## 自动化测试

```bash
npm test
```

测试覆盖：空库/已有库迁移重复执行、003 DDL/约束/索引、`VARCHAR(64)` 外键与 `ON DELETE RESTRICT`、种子幂等、四种登录主体与双角色、401 先于 403、菜品 CRUD/上下架/删除保护、名称与 BIGINT 价格边界、图片 JPEG/PNG/WebP、空/多文件、损坏内容、5 MB 边界、员工上传 403、私有图片鉴权读取、替换/移除后旧地址 404、无图占位、审计不变性、统一错误信封、trace、日志脱敏和数据库故障恢复。

常规测试显式使用 `OBJECT_STORAGE_DRIVER=memory`。真实 MinIO/S3 的匿名直读、应用代理和旧地址失效必须另设 `OBJECT_STORAGE_TEST_ENDPOINT` 运行 `test/object-storage.integration.test.ts`，内存适配器不能作为私有桶验收证据。

数据库连接优先级：

1. `TEST_DATABASE_URL`（推荐在已有 PostgreSQL 上运行）；
2. 否则尝试 Testcontainers 启动 `postgres:16-alpine`；
3. Docker 不可用时回退到内嵌 PostgreSQL 兼容 wire server（PGlite），仅用于受限开发环境，不替代发布前的真实 PostgreSQL 验证。

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/loopforge_test npm test
```

## 日志与 trace

应用逐行输出 JSON 到 stdout。每个请求由服务端生成 UUIDv4；客户端传入的 `X-Trace-Id`/`traceparent` 不会被信任。访问日志记录 `timestamp`、`traceId`、方法、pathname、状态、耗时；错误日志记录 `timestamp`、错误码、异常类型与 5xx 堆栈。日志不记录查询串、Cookie、Authorization、授权码、断言、client secret、数据库密码或会话密钥；运行时脱敏器会替换已知密钥与 JWT 形态字符串。

```bash
# 服务在前台运行时，另开终端检索：
npm run dev 2>&1 | tee app.log
rg '"traceId":"<响应中的 traceId>"' app.log
```

健康检查：

```bash
curl -i http://localhost:8080/healthz
```

数据库停止后，健康检查在配置超时（默认 2 秒，最多 10 秒）内返回 `503`：
`{"status":"DOWN","code":"SERVICE_UNAVAILABLE","message":"服务暂不可用","traceId":"..."}`，不返回连接串、账号或堆栈。

## 生产部署顺序

1. 构建并发布镜像（`docker build -t loopforge-base-auth .`），或构建 `npm ci && npm run build` 产物。
2. 以外部注入方式提供 `APP_ENV=prod`、`DATABASE_URL`、`SESSION_SECRET`、完整 OIDC 配置和 `OBJECT_STORAGE_*`；桶须预创建、公共访问阻断、应用账号仅有 `dish-images/` 前缀权限。不要使用 `.env.example` 占位值。
3. 独立迁移 job：`node dist/db/migrate-cli.js`（本地源码模式为 `npm run migrate`）。
4. 启动应用：`node dist/server.js`。
5. 轮询 `GET /healthz` 直到 `200 {"status":"UP"}`，再接入流量。
6. 生产不执行 seed、不启动 Mock IdP、不注册测试异常路由，`LOG_LEVEL` 不得为 `debug`。

## 当前边界

- 不实现登出、单点登出、服务端会话表或主动单会话撤销。
- 没有后台组织目录同步；账号停用/角色变更在登录同步或外部数据库更新后的下一次请求生效。
- 不实现每日菜单、菜单发布状态机、员工菜单页面、订单、购物车或下单。
- 不实现菜品分类主数据、多图、图集、裁剪、缩略图、历史图片浏览、软删除或回收站。
- 员工图片可见性端口在本仓库默认拒绝；真实菜单模块接入后必须提供“已发布且开放窗口内、对当前员工可见”的查询。
- 已被菜单或订单引用的菜品删除保护依赖下游真实外键；当前只用隔离契约探针验证类型和 `ON DELETE RESTRICT`，不视为下游端到端验收。
