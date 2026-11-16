# 运行配置与迁移

工作台由 `npm start` 提供页面和数据 API；管理与模型服务由 `npm run start:admin` 提供。两者使用 Node.js 24 内置 HTTP、SQLite 与加密模块，可分别部署到具备长运行进程和持久存储的环境。无需 Python 或系统专用安装程序。

## 配置项

| 变量 | 用途与默认值 |
| --- | --- |
| `HOST` / `PORT` | 工作台监听，默认 `0.0.0.0` / `3000` |
| `DATA_DIR` | 工作台持久化目录，默认 `./data` |
| `APP_VERSION` | 显示的运行版本，工作台默认 `0.3.0`，管理端默认 `development` |
| `COOKIE_SECURE` | `true` 时工作台与管理会话要求 HTTPS |
| `MODEL_GATEWAY_URL` | 模型服务基础路径，例如 `https://models.example.com/internal/model` |
| `MODEL_BRIDGE_TOKEN` / `MODEL_BRIDGE_TOKEN_FILE` | 双方共享的 64 位十六进制随机认证值；文件优先 |
| `ADMIN_HOST` / `ADMIN_PORT` | 管理服务监听，默认 `0.0.0.0` / `3100` |
| `ADMIN_DATA_DIR` | 管理数据库目录，默认源码 `admin/data` |
| `ADMIN_ORIGIN` | 管理页实际访问来源，如 `https://admin.example.com`；未设置外部来源或额外 Host 时仅接受回环 Host |
| `ADMIN_ALLOWED_HOSTS` | 额外允许的 Host，逗号分隔，按实际请求包含端口；适用于内部模型调用与健康探测 |
| `WORKBENCH_ORIGIN` | 域名验证比对的工作台来源，同时作为管理页打开工作台的地址；默认 `http://127.0.0.1:3000` |
| `SECRET_ENCRYPTION_KEY` / `SECRET_ENCRYPTION_KEY_FILE` | 独立的 64 位十六进制 AES-256-GCM 主密钥；文件优先 |
| `WEBSITE_HOST` / `WEBSITE_PORT` | 可选网站访客监听，设置端口后启用，默认监听 `0.0.0.0` |
| `WEBSITE_ORIGIN` | 网站访客独立来源，启用访客监听时必填 |

来源仅接受 HTTP/HTTPS，不包含账号密码、路径、查询或锚点。模型网关地址需要保留 `/internal/model` 路径，不会把实际地址改写为回环地址。缺少模型连接或共享令牌时，工作台仍可使用账号、数据和内置工具，模型对话明确返回未配置状态。

密钥未配置、密文损坏或加密主密钥错误时，凭据操作报错，不生成替代密钥，不覆盖原密文。迁移时数据库与同一加密主密钥缺一不可。旧系统专用密文需要重新输入服务商密钥，旧账号、会话、目录和统计无需重建。

## 接入平台

让平台分别启动两个进程，并将对应持久磁盘映射到 `DATA_DIR` 与 `ADMIN_DATA_DIR`。在管理服务设置共享令牌、加密主密钥、管理页来源和需要的内部 Host；工作台设置相同令牌与模型服务基础地址。

工作台反向代理保留 Host 与浏览器 Origin，转发 `/api/` 和静态资源到同一服务。管理页的 Host 必须匹配 `ADMIN_ORIGIN` 或明确允许列表；POST 的 Origin 必须匹配 `ADMIN_ORIGIN`。内部模型接口拒绝浏览器 Origin / Sec-Fetch 请求，并验证桥接令牌。HTTPS 管理来源自动设置 Secure Cookie。TLS、证书签发、网络路由、重启策略与发布由目标平台管理。

网站文件、生成、发布快照和导出 API 保留在管理服务。启用访客监听需配置独立的 `WEBSITE_ORIGIN`，避免用户编写的脚本与账号页面共享来源；访客服务不提供管理接口。域名登记只保存配置，不会更改 DNS 或安装证书；检测比对有效 DNS、TLS 与 `WORKBENCH_ORIGIN` 返回的实例身份。

## 数据与容量

工作台数据库为 `workspace.sqlite`，管理数据库为 `admin.sqlite`。两者启用 WAL；停止服务后再复制整个数据目录，或使用 SQLite 一致性快照。不能在持续写入时只复制主数据库文件而忽略 WAL。工作台快照工具使用相同的 `DATA_DIR` 配置，在该目录下的 `backups/` 写入快照：

```bash
node --env-file-if-exists=.env src/backup.mjs
```

工作空间 JSON 导入导出保留。单次工作空间请求限制 16 MB；TXT、Markdown、CSV、JSON 支持 UTF-8 正文，每个文件不超过 1 MB，正文总量不超过 150 万字符；其他文件只保留信息。不要把数据库、凭据、上传内容或真实运行配置提交到公开仓库。

SQLite 完整模式需要持久磁盘和长运行进程；不提供多副本共享数据库或函数运行时适配。纯静态环境仅交付 `npm run build` 的 `dist/`。
