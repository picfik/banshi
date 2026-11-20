# 办事流程台账 PWA

React、TypeScript 和 Vite 制作的 PWA，静态页面部署在 GitHub Pages。事项 JSON 与附件由浏览器通过 `ali-oss` 直接读写阿里云 OSS，不需要 Express API。每次打开应用时，先从 OSS 读取 `casework/data/cases.json`；保存事项后立即上传 JSON，附件上传和删除也直接写入 OSS。

## GitHub Pages 部署

1. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 配置：
   - Repository secrets：`VITE_OSS_AK`、`VITE_OSS_SK`
   - Repository variables：`VITE_OSS_BUCKET`、`VITE_OSS_REGION`、`VITE_OSS_PREFIX`（可选，默认 `casework`）
2. 在 **Settings → Pages** 将 **Build and deployment → Source** 设为 **GitHub Actions**。
3. 推送到 `main`，`.github/workflows/deploy.yml` 会自动构建并发布 Pages。也可在 **Actions** 页面手动运行部署工作流。

杭州地域填 `oss-cn-hangzhou`。Bucket 名称与地域应和阿里云控制台一致。

## 本地运行

需要 Node.js 20 或更高版本。复制 `.env.example` 为 `.env` 并填入上述 OSS 参数，然后运行：

```powershell
npm install
npm run dev
npm test
npm run build
```

开发时访问 Vite 显示的本地地址。Bucket 的 CORS 规则需允许该地址以及已发布的 Pages Origin。

## OSS 配置

应用使用以下对象路径：

- 业务数据：`<VITE_OSS_PREFIX>/data/cases.json`
- 附件：`<VITE_OSS_PREFIX>/attachments/<事项 ID>/<附件 ID>`

Bucket CORS 至少允许 Pages 的 Origin 和 `GET`、`PUT`、`DELETE` 方法，并允许 ali-oss 实际使用的 `Authorization`、`Content-Type` 和 `x-oss-*` 请求头。CORS 仅处理浏览器跨域访问；OSS 授权策略还需允许对上述对象执行读取、写入和删除。

旧版服务端使用的默认 JSON 与附件路径兼容，部署后可直接从已有 `casework/data/cases.json` 加载。若数据对象不存在，应用会创建初始 JSON。应用不会把业务 JSON 缓存在浏览器中作为启动数据；打开失败时会显示错误，不会用空数据覆盖 OSS。

## 使用限制

- Pages 是静态站点，没有服务端登录。登录界面已移除；打开站点的人都能使用应用。
- 流程校验在浏览器中执行，不是服务端强制规则。审计记录保存在同一个 JSON 对象中，不是防篡改审计系统。
- 多个浏览器同时编辑时，后保存的整份 JSON 可能覆盖先保存的更改；目前不提供并发合并。
- 附件仅支持 PDF 和纯文本，单个文件上限 10 MiB。不同事项中，文件名和大小相同的附件会复用 OSS 对象，仅新增关联；同名同大小但内容不同的文件也会按此规则视为同一文件。删除事项时，只清理不再被其他事项引用的 OSS 附件；删除附件时，若仍被其他事项引用则会拒绝删除。
- 可在页面的“AI 设置”中选择阿里云百炼或腾讯混元，填写服务商 API Key 和模型名称。设置会保存到 OSS 的 `casework/data/cases.json`，其他设备打开应用时会自动读取，无需逐台重复配置；无需在 GitHub Secrets 中设置 AI Key。解读前会要求确认，应用从 OSS 读取 PDF/TXT，在本机提取文本后直接发送给所选服务商，并将分析结果保存到 OSS 事项数据中。请确认材料获准发送；服务商跨域或网络限制可能导致浏览器请求失败。
- AI API Key 与事项数据保存在同一个 OSS JSON 中。任何能够通过当前应用读取该 OSS 对象的人都能读取 AI 配置；更改 AI 设置后，各设备重新加载页面即可获取新配置。
- PDF 文本提取最多读取前 100 页和 24,000 个字符；扫描版 PDF 暂不支持 OCR。AI 分析仅供辅助整理，需由工作人员核验原始材料和事实。
- Service Worker 只缓存 Pages 的静态应用资源，不缓存 OSS 数据或附件。离线时不能编辑或同步。

## GitHub Actions 密钥说明

工作流使用 `VITE_OSS_AK` 和 `VITE_OSS_SK` 构建前端，和 `gzlh` 项目采用相同的浏览器直连 OSS 模式。Vite 会把 `VITE_*` 值编译进公开的前端文件；GitHub Secrets 只是在构建日志中隐藏输入值，并不会隐藏已部署网页里的凭据。不要在仓库中提交真实 `.env` 或 OSS 密钥。请按需决定是否接受这种部署方式，并避免使用主账号或不必要的高权限凭据。
