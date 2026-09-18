# 单页 Word 导出

页面菜单的「导出」支持 Word（`.docx`），无需企业授权。导出数据库中已保存的当前页面正文，并在文档开头添加页面标题。文件中的文字、列表和表格可编辑。导出不修改页面，也不合并子页面、不打包附件、不支持整空间 Word 导出。

## 接口与权限

`POST /api/pages/export-docx` 接收 `{ "pageId": "页面 ID" }`，复用登录校验、页面读取权限和页面导出审计。无权访问、跨工作区及已删除页面不能导出。接口独立于企业模块的 `/docx-export`。

成功响应为 DOCX 二进制，MIME 类型为 `application/vnd.openxmlformats-officedocument.wordprocessingml.document`。`Content-Disposition` 包含清理、编码后的文件名及 UTF-8 `filename*`；`X-Docmost-Export-Warning-Count` 表示降级项数量。前端下载后有降级项时显示「已导出，部分内容未完整转换，请查看文档内说明」。HTTP 错误以 JSON 返回，前端在二进制请求的错误处理路径中解码。

页面查询、权限查询或文档生成失败会使整个请求失败。单张图片缺失、不可读取或格式不支持时，导出继续，并在图片位置添加说明。附件工作区、附件所属页面及其读取权限均须通过检查；权限失败的说明不包含附件名称、路径等元数据。

## 内容支持

| 内容 | 导出行为 |
| --- | --- |
| 标题、正文、换行、粗体、斜体、删除线、下划线、上下标、文字颜色、高亮、链接 | 转为 Word 对应内容 |
| 有序列表、无序列表、嵌套列表、任务列表 | 保留列表；有序列表保留起始编号，任务列表保留勾选状态；超过 Word 的 9 层限制时提示并展开 |
| 表格与合并单元格 | 保留横向、纵向合并；列宽按逻辑列数分配 |
| 脚注、分页符 | 复用已有转换能力 |
| 正文图片 | 通过附件 ID 或相对 `/api/files/<id>/...` 路径解析附件，检查权限后从 `StorageService` 读取；按文件签名识别 PNG、JPEG、GIF、BMP，按实际尺寸等比缩小，正文最大宽度 600 像素 |
| 外部图片、缺失图片、SVG、WebP 等不支持格式 | 不主动抓取外部地址；在原位置添加说明并计入降级数量 |
| Draw.io、Excalidraw | 已有附件为受支持图片时嵌入；SVG 或不可读取的图示显示说明，不启动图示渲染服务 |
| 视频、音频、PDF、附件、网页嵌入 | 保留已保存的名称或链接，并提示降级 |
| 多栏 | 按顺序展开，并提示布局降级 |
| 公式 | 保留 LaTeX 文本，并注明未转换为排版公式 |
| 引用块引用、Base、子页面列表、未知节点 | 原位置显示未转换说明；未知文字样式保留文字并注明样式未转换 |

Word 模式隐藏子页面和附件打包选项。Markdown、HTML 和空间导出的原有格式保持可用。

## 本地验证

构建与针对性测试：

```sh
pnpm --filter @docmost/editor-ext build
pnpm --filter server build
pnpm --filter client build
pnpm --filter server exec jest --runInBand docx-export.spec.ts common/guards/jwt-auth.guard.spec.ts
```

后端测试使用真实转换器和页面权限服务、模拟数据库及存储边界，覆盖登录 guard、页面及附件权限、删除状态、跨工作区、外部及缺失图片、不支持内容、文件生成失败。解包生成文件检查中文、文字样式、链接、列表编号、合并单元格、图片关系、脚注、分页符和占位说明，并检查原始正文未被修改。

浏览器回归脚本使用已有本地 Compose 数据库，以及在 `http://127.0.0.1:3012` 启动的当前构建。验证进程需要现有本地环境的数据库、Redis 和 `APP_SECRET` 配置；`APP_URL` 应指向该验证端口。脚本从本地容器读取配置用于临时登录，不输出凭据。脚本创建独立临时空间、页面及图片，在结束时清理，并核对原有页面标题和正文未变。仅用于本地验证，不应连接生产实例。

```sh
PLAYWRIGHT_MODULE=/path/to/playwright-core node tests/docx-export.local.cjs
```

`DOCX_TEST_URL` 可指定其他 `127.0.0.1` 验证端口，`DOCX_TEST_OUTPUT` 可指定样本保存目录，默认 `/tmp/docmost-docx-validation`。验证结束后停止临时服务进程；既有 Compose 实例无需重建或替换。

2026-09-18 本地验证结果：

- 编辑器扩展、服务端及客户端构建通过；33 项针对性测试通过。
- Chromium 回归通过：社区版 Word 选项、选项显隐、中文下载文件名、成功及降级提示；通过注入 HTTP 响应验证 403/404/500 JSON 错误提示；Markdown/HTML 下载正常。实际 HTTP 登录、无效请求、缺失及已删除页面检查通过。
- 中文、图片和横纵合并单元格样本生成并解包检查通过；源正文及已有页面未变；临时测试数据已清理。
- Word/WPS 图形界面兼容性与排版尚未验证：当前环境的 WPS 在隔离 Xvfb 显示环境中启动即退出，退出码 255，未打开样本。Microsoft Word 不可用。ZIP/XML 结构检查不能代替这一项。

无需数据库迁移或新增常驻服务。本地 `192.168.1.60:3010` 使用 `docmost-local:word-export`，已通过全新浏览器会话确认 Word 选项启用、无 Enterprise 标识，并实际下载有效 DOCX 文件；配置和数据卷保持不变，数据库及 Redis 未重启。旧浏览器页面需刷新以加载新版前端。

## 发布与回滚

发布镜像需要同时包含当前服务端、客户端和 `@docmost/editor-ext` 构建。只更新前端会使 Word 选项可见但无法下载；只更新服务端会保留旧前端的 Enterprise 限制。

70 环境位于 `10.0.1.70:/home/runsisi/docmost`，使用 rootless Podman 和 `podman-compose`，通过 `http://docs.xcube.com` 访问。发布前保留旧镜像、Compose 配置及环境文件，并备份数据库和附件。Compose 使用已推送镜像的 digest，仅重建应用容器，保持现有数据库、Redis、数据卷及 Gitea 配置。

该功能无需数据库迁移，回滚时恢复旧应用镜像与 Compose 配置即可。不要为回滚应用而恢复旧数据库或附件备份，以免丢失发布后的写入。发布后的验证应包含健康检查、前端资源、Gitea 登录跳转、协作 WebSocket，以及 Word 菜单和实际文档下载。
