# 办事流程台账 PWA

一个用于辅助记录办事事项来源、办理过程和最终闭环的内部工具 MVP。步骤状态由服务端校验，业务数据采用服务端 JSON 文件，附件保存在服务端本地副本并可同步到私有阿里云 OSS。AI 默认关闭；它只用于材料整理，不代替工作人员作出办理或审批决定。

## 本地运行

需要 Node.js 20 或更高版本。首次安装依赖后：

1. 复制 `.env.example` 为 `.env`，设置随机生成的 `SESSION_SECRET`（至少 32 个字符）及登录凭据。
2. 运行 `npm install`。
3. 运行 `npm run dev`。Vite 默认在 `http://localhost:5173`，API 服务在 `http://localhost:3000`。
4. 使用 `AUTH_USERNAME` 和 `AUTH_PASSWORD` 登录。

生产构建及测试：

```powershell
npm test
npm run build
npm start
```

`npm start` 启动 API 服务。生产环境应由 HTTPS 反向代理或同源网关托管 `dist/` 静态资源并转发 `/api`；不能将含有密钥的后端部署到 GitHub Pages。请确保代理保留 Cookie，并将 `NODE_ENV` 设为 `production`。

## 环境变量

| 变量 | 用途 |
| --- | --- |
| `PORT` | API 监听端口，默认 3000 |
| `HOST` | 监听地址，默认 `127.0.0.1`；需容器外访问时按部署网络设置 |
| `AUTH_USERNAME` / `AUTH_PASSWORD` | 单一工作账号凭据；请使用部署平台 Secret |
| `SESSION_SECRET` | 至少 32 字符的随机签名密钥；部署平台 Secret |
| `DATA_DIR` / `UPLOAD_DIR` | 服务端 JSON 数据及附件目录，默认位于 `server/` 下 |
| `WORKFLOW_STAGES_JSON` | 可选的阶段/步骤 JSON 数组；留空使用默认顺序。步骤可设置 `requiresReview: true` 强制人工确认 |
| `OSS_REGION` / `OSS_BUCKET` | OSS 地域及私有 Bucket |
| `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` | OSS 最小权限 RAM 凭据；仅服务端环境变量 |
| `OSS_PREFIX` | OSS 对象 key 前缀，默认 `casework` |
| `AI_ENABLED` | 仅显式设为 `true` 才会启用 AI |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | 兼容 OpenAI Chat Completions 的 AI 服务端点、密钥和模型 |

### 在 GitHub 中保存部署密钥

在仓库的 **Settings → Secrets and variables → Actions → New repository secret** 中添加 `OSS_REGION`、`OSS_BUCKET`、`OSS_ACCESS_KEY_ID` 和 `OSS_ACCESS_KEY_SECRET`。同时，运行服务还必须配置 `AUTH_USERNAME`、`AUTH_PASSWORD` 和至少 32 个字符的随机 `SESSION_SECRET`。这些值应作为服务端环境变量使用；`OSS_PREFIX` 可设为普通环境变量，默认为 `casework`。

GitHub Actions Secrets 只提供给工作流使用，不会自动变成已部署服务器的环境变量。若通过 Actions 部署，工作流必须在部署步骤中显式将 `${{ secrets.OSS_REGION }}` 等值传给目标托管平台；也可以直接在托管平台的服务设置中配置这些变量。不要把密钥写入前端变量、代码或提交到仓库。项目需要运行 Express API，不能只部署到 GitHub Pages。

当启用 AI 时，调用将把纯文本材料内容发送至所配置的 AI 服务商。启用前应确认单位授权、数据处理条件和服务商要求。未启用 AI 时系统不生成占位或虚构分析结果。MVP 仅对 `text/plain` 提取文本；PDF 可上传和人工查看，但不会自动解析。

## 办理路径与采购步骤

- 在事项的“明确承办安排”步骤选择“普通办理”或四种采购模式之一。采购模式在进入“开展办理并记录依据”后，会展开对应步骤清单。
- 每个采购步骤都必须填写记录并由服务端标记完成；服务端不允许跳过前序步骤，也不允许在采购子步骤未全部完成时完成“开展办理并记录依据”。
- “采购路径设置”页可分别编辑四种模式的步骤名称、办理提示及顺序，最少 1 步、最多 50 步。配置保存在业务 JSON 中并随数据同步 OSS。
- 默认内容只是可编辑示例，不是法定流程或单位制度。请先按本单位现行制度配置、审核，确认后再用于真实业务。
- 事项选择采购模式时会保存该模式的步骤快照；后续设置变更只影响之后选择该模式的事项，不会悄悄改写已开始办理的流程。

## 全域搜索

登录后可按关键词搜索事项名称、来源与说明、办理记录、采购步骤、材料文件名、可提取的 TXT 文本及 AI 整理结果。搜索结果显示命中字段和短摘录，最多返回 100 条；PDF 内容未解析，因此只能搜索其文件名及关联记录。

自定义流程示例（通过部署环境变量设置为单行 JSON；步骤顺序就是办理顺序）：

```json
[
  { "id": "source", "title": "事项来源", "steps": [
    { "id": "register", "title": "登记来源", "guidance": "记录事项来源和接收时间。" }
  ] },
  { "id": "closure", "title": "最终闭环", "steps": [
    { "id": "review", "title": "人工确认", "guidance": "工作人员核对并确认闭环。", "requiresReview": true }
  ] }
]
```

配置要求阶段与步骤 ID 全局唯一，仅使用小写字母、数字和连字符；最多 20 个阶段、100 个步骤。

## OSS 和数据恢复

- OSS Bucket 必须保持私有，凭据使用最小权限 RAM 用户，并仅允许服务端通过 HTTPS 访问；不要在前端代码、浏览器存储或仓库设置静态访问密钥。
- 业务 JSON 变更后会尝试上传 `casework/data/cases.json`；附件 key 位于 `casework/attachments/`。同步状态会显式显示，失败时可重试。没有配置 OSS 时数据只保存在服务端。
- 服务端本地 JSON 和附件副本位于 `DATA_DIR` 与 `UPLOAD_DIR`。备份时应一致性地备份这两个目录；恢复时先停止服务，再恢复目录并验证 JSON 文件有效后启动。
- OSS 对象是异地副本，不是自动双向恢复/冲突合并系统。恢复流程应以选定的一份 JSON 备份为准，再核对引用的附件对象；OSS 当前没有历史版本恢复、生命周期策略或多副本冲突解决。
- JSON 文件方案只适合单实例、小规模使用。多进程/多实例并发写入不具备数据库事务和跨实例锁保障；正式多人协同前应迁移到具备访问控制、事务和备份能力的数据库。

## 安全与限制

- API 使用带 `HttpOnly`、`SameSite=Strict` 的签名会话 Cookie。MVP 只有一个部署账号；上线前应接入单位认可的身份认证、角色/事项级权限和会话撤销能力。
- Service Worker 仅缓存应用静态资源；不缓存 `/api`、业务 JSON 或附件。离线时不允许新增或编辑业务记录。
- 附件大小上限 10 MiB，仅接受 PDF 和纯文本；文件保存在服务端本地目录，并通过受认证 API 查看。应保护数据目录、限制服务器访问并配置可靠备份。
- 审计记录与业务 JSON 一同保存，不是独立的防篡改审计系统。应根据单位的数据分类、保留期限、访问审批和安全测评要求完善后再用于真实业务。
- AI 输出均为辅助信息，不能作为正式审批、法律意见或权威合规结论。工作人员必须核验材料原件、政策依据和办理事实。

不要把真实业务材料、业务数据文件或任何密钥提交到 GitHub。`.gitignore` 已排除本地 `.env`、业务数据目录、附件目录和构建产物。
