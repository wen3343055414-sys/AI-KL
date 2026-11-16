# 智作台 · 中文 AI 工作台

把会话、提示词、知识资料、任务与内置工具放在同一个工作空间。保留完整工作台、账号登录、数据同步、真实模型调用和独立管理服务，运行方式不依赖特定电脑或托管商。

## 功能

- 多轮对话与历史搜索、继续对话、复制导出、重新请求和模型选择。
- 提示词编辑、分类与收藏，知识资料文本读取、搜索和带入对话。
- 任务清单、工作空间搜索、Unicode 文本统计与 JSON 导入导出。
- 账号与邮箱密码登录、账号隔离、SQLite 持久保存、跨页面同步、离线缓存及冲突处理。
- 多服务商与多模型管理，OpenAI 兼容、Anthropic Messages、Gemini 文本协议，加密凭据、实际 Token 统计和月限额。
- 独立管理登录、操作记录、网站草稿/发布快照/模型生成接口，以及域名 DNS、HTTPS 与工作台实例验证。
- 深色主题、手机布局、侧栏收起与展开。保留旧工作空间、演示历史标记和账号兼容。

手机短信、邮箱验证、邮件找回及第三方登录尚未接入，界面会如实提示。

## 运行入口

需要 **Node.js 24.10.0 及以上的 24.x**。生产代码只使用 Node.js 内置模块；数据服务需要可写的持久化目录。

```bash
npm ci
npm start
```

`npm start` 提供完整工作台页面与数据 API；`npm run dev` 用于开发时监听源码变化。通过运行环境注入配置，变量名称见 [.env.example](.env.example)。程序也支持读取仓库根目录的 `.env`，真实配置不提交仓库。

独立模型与管理服务使用：

```bash
npm run start:admin
```

两项服务可以运行在同一环境，也可以分别交付。工作台通过 `MODEL_GATEWAY_URL` 访问管理服务的 `/internal/model`，双方使用相同的 `MODEL_BRIDGE_TOKEN` 或对应的秘密文件。服务地址支持 HTTP/HTTPS 和自定义主机名。跨公网连接使用 HTTPS。

使用模型凭据前，为管理服务设置 `SECRET_ENCRYPTION_KEY` 或 `SECRET_ENCRYPTION_KEY_FILE`，再在管理页面添加服务商与模型。以下命令可生成一个 32 字节随机值；桥接令牌和加密主密钥分别生成、分别保管：

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
```

管理页通过 `ADMIN_ORIGIN` 配置实际访问来源，`ADMIN_ALLOWED_HOSTS` 可补充内部连接所用的 Host。HTTPS 来源自动启用管理会话 Secure Cookie。不要将服务商 API 密钥放入工作台前端。

## 可移植性与数据

- 完整服务适用于提供 Node.js 24 长运行进程、网络与持久磁盘的环境。监听地址、端口、数据目录、版本和服务来源均可配置。
- 平台提供的反向代理保留原始 Host 与 Origin；TLS、进程管理、日志收集和发布由目标平台负责。详见 [运行配置](docs/runtime.md)。
- `DATA_DIR` 保存工作台账号、会话和工作空间；`ADMIN_DATA_DIR` 保存管理账号、模型设置、用量、网站与域名。迁移时停止写入后搬迁数据库目录，并保留相同的加密主密钥和服务桥接令牌。
- 旧系统专用格式的模型密文不能直接跨系统解密，迁移后需重新输入相应连接的 API 密钥；账号、模型目录、用量及业务内容保持原有数据库结构。
- 程序不会安装操作系统服务、修改防火墙、操作主机容器或自动更新自身。数据库快照工具与工作空间 JSON 导入导出继续保留。

## 静态交付

```bash
npm run build
```

构建结果在 `dist/`，使用相对资源路径和 hash 导航，可交付给任意支持静态文件的托管服务。`deploy-pages.yml` 是仅发布 `dist/` 的可选工作流示例。

静态模式保存当前浏览器的数据；账号登录、服务端同步和真实模型调用需要完整后端。纯静态托管和无持久磁盘的函数环境不能直接提供 SQLite 完整服务。

## 验证

```bash
npm test
npm --prefix admin test
node scripts/check-source.mjs
npm run build
```

`npm test` 包含工作台和管理服务测试。`ci.yml` 保留跨系统应用验收与浏览器验收示例，放入 `.github/workflows/` 后可用于 GitHub Actions。浏览器验证使用 `scripts/auth-ui-check.mjs`，工具依赖独立安装，不进入生产依赖。

## 目录

| 路径 | 内容 |
| --- | --- |
| `public/` | 工作台界面、账号交互、浏览器缓存与同步 |
| `src/` | HTTP 服务、账号与工作空间 SQLite、模型客户端、数据库快照 |
| `admin/` | 独立管理界面、模型配置与协议、用量、网站与域名业务 |
| `scripts/` | 静态构建、源码检查及界面验收 |
| `tests/`、`admin/tests/` | 应用和业务回归测试 |
| `docs/` | 账号、运行配置、模型与开发说明 |

[账号说明](docs/authentication.md) · [管理服务](admin/README.md) · [多模型说明](docs/multi-model-settings.md) · [开发流程](docs/development-workflow.md) · [项目工作规则](AGENTS.md)
