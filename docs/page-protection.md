# 页面保护锁

页面保护是所有协作者共享的持久化设置。页面顶部的锁图标切换显式锁定／解锁，旁边菜单可恢复“继承父页面”。菜单和提示文字区分本页显式设置、继承状态和默认解锁；没有来源页面访问权限时不返回其名称和 ID。

根页面默认解锁，新建子页面默认继承。沿当前祖先链向上查找，最近的显式设置生效。例如 A 锁定、B 继承、C 显式解锁，C 及继承 C 的后代可以编辑；再次切换 A 不会改写 C 的设置。

## 权限与写入边界

原有空间权限和页面访问限制决定谁可以访问、编辑和管理保护设置。保护锁不会授予额外权限。

| 操作 | 锁定后的行为 |
| --- | --- |
| 正文、标题、图标、封面、标签、页面文件上传或替换 | 拒绝内容写入 |
| 历史正文恢复 | 沿用编辑器恢复流程，正文和标题分别受协作与 HTTP 检查 |
| 移动、排序、删除、回收站恢复、复制、创建子页面 | 沿用原有权限 |
| 评论、回复、解决和重新打开评论 | 沿用原有权限 |
| 行内评论标记 | 仅通过已授权的服务端评论操作更新 |
| 修改保护设置 | 原本有编辑权限且页面未删除的用户可操作 |

`PageAccessService.validateCanEdit` 保留原有编辑权限语义，`validateCanModifyContent` 负责内容写入检查。详情中的 `permissions.canEdit` 保持原义；`canModifyContent` 和 `canManageProtection` 分别控制内容和保护设置入口。

HTTP 写入检查和协作更新检查均实时查询数据库，不缓存保护状态。协作服务在 Hocuspocus `beforeSync` 中检查，包括已有连接的 Yjs update 和重连时的 SyncStep2。数据库或权限查询失败时拒绝更新。已通过写入检查的在途操作允许完成；协作持久化继续保存服务端已接受的更新。

附件内容节点的删除由正文写入检查保护。现有附件清理任务仍负责回收已无引用的数据，不新增文件删除接口。

## 数据与版本

迁移 `20260917T160000-page-protection` 将 `pages.is_locked` 改为可空：

- `NULL`：继承；已有默认 `false` 转为 `NULL`。
- `true`：显式锁定；迁移保留已有 `true`。
- `false`：显式解锁。

`protection_version` 由数据库触发器递增，覆盖设置、父页面、空间和删除状态的实际变化。有效版本是完整祖先链中页面 ID、版本和空间 ID 的摘要。因此移出后移回、祖先上锁后解锁都产生不同版本，即使最终锁状态相同。

页面接口的 `isLocked` 始终是最终状态的布尔值，显式设置从 `protection.mode` 读取。页面树通过一次批量祖先查询计算返回页的状态，不逐页查询祖先。复制时复制各节点的原始显式设置；移动和回收站恢复后按实际位置计算继承。

```json
{
  "pageId": "页面 UUID",
  "mode": "inherit",
  "version": "页面详情返回的 protection.version"
}
```

通过 `POST /api/pages/protection` 提交上面的请求。`mode` 支持 `inherit`、`locked`、`unlocked`。服务端验证工作区、访问权限和原有编辑权限，并在空间层级事务锁内比较版本、更新本页设置。版本过期返回 `409`，客户端重新获取状态后由用户决定是否重试。

数据库事务提交后通过 PostgreSQL `NOTIFY` 向应用发送旧／新空间 ID，应用再广播 `pageProtectionInvalidated`。通知不包含页面名称或内容。浏览器收到通知或重新连接时重新查询有权访问的页面；协作写入正确性不依赖通知及时到达。

## 断线与本地恢复

协作认证携带页面保护版本，重连不能把旧文档自动绑定到新版本。浏览器的 IndexedDB 文档按页面和保护版本隔离。旧版本文档不会合并进新版本；启用此功能前未带版本的旧缓存也不会自动导入。

正文的未确认修改和标题的延迟保存内容另存为本地恢复副本。标题请求使用编辑发生时的版本；发生保护变化时，旧请求不会借用新版本提交。恢复副本提供复制、Markdown 导出和丢弃操作，保存在当前浏览器，不上传服务器，不在解锁后自动重放。已收到服务端确认的当前副本可清除。

有效版本包含完整祖先链，因此上级变化可能令显式解锁页面也切换协作版本。其最终解锁状态不变，未确认修改仍按版本变化规则保留。

## 上游集成边界

保护锁通过独立服务、控制器和前端 Hook 接入，上游文件保留权限检查调用、Hook 调用及模块注册。

| 独立实现 | 职责 |
| --- | --- |
| `core/page/protection/` | 设置接口、祖先状态计算、响应字段及来源可见性 |
| `collaboration/services/collaboration-protection.service.ts` | 协作认证版本与同步前拒写检查 |
| `features/editor/use-collaboration-protection.tsx` | 版本隔离、协作只读状态和正文恢复副本 |
| `features/editor/use-title-protection.ts` | 标题修改的版本绑定、确认和恢复副本 |
| `features/page/hooks/use-page-protection-subscription.ts` | 状态失效与重连后的重新查询 |
| `ws/page-protection.bridge.ts` | 数据库事务提交后的空间通知 |

历史恢复使用原有的编辑器命令和标题同步流程；等待历史内容期间保护版本变化时中止恢复。
回收站恢复保留原有主体逻辑，由事务包装统一层级锁和提交后通知。复制仅增加显式保护设置的保留。

## 本地验证

使用 `data/local/compose.yaml` 的现有应用、PostgreSQL、Redis 和附件卷，地址为 <http://192.168.1.60:3010>。本地镜像名为 `docmost-local:page-protection`。

```bash
pnpm build
pnpm --filter server test --runInBand --runTestsByPath \
  src/core/page/page-access/page-access.service.spec.ts \
  src/core/page/protection/page-protection.interceptor.spec.ts \
  src/collaboration/services/collaboration-protection.service.spec.ts \
  src/collaboration/yjs.util.spec.ts \
  src/core/comment/comment.service.spec.ts

# 使用已有 Playwright 安装；不创建其他应用、数据库或 Redis。
PLAYWRIGHT_MODULE=/path/to/playwright-core node tests/page-protection.local.cjs
```

本地浏览器脚本要求现有管理员、普通成员、`general` 和 `xcube` 空间。它为只读和非成员场景创建临时账号，不修改现有账号权限；测试页面和账号在结束时清理，并校验原文档未变化。截图及导出文件默认保留在 `/tmp/docmost-protection-validation`。

数据库查询失败的拒写行为由权限服务和协作钩子测试注入异常验证，不通过停止共享数据库制造故障。

## 本地验证结果（2026-09-17）

候选镜像 `docmost-local:page-protection`，镜像 ID 为
`sha256:fe1fe13206fdbdc355afaf29cd207d8b2a216d4ae10df19d3f0a8f66ad82705f`。

- 四个工作区包构建通过，客户端 TypeScript 检查通过，24 项自动化测试通过。
- 现有管理员、普通成员和临时只读／非成员账号完成 HTTP 与双浏览器验证：多层继承、显式覆盖、版本冲突、内容拒写、新建、移动、跨空间移动、复制、恢复及从已删除父页脱离。
- 已有协作连接的强制写入被拒绝；评论、回复、服务端行内标记、解决及重新打开保持可用。
- 断线期间反复锁定／解锁、重连、重载、恢复副本复制和导出均通过；延迟标题请求使用编辑时版本，未以新版本补写旧标题。
- 历史弹窗在双浏览器中同步恢复标题和正文，保护设置不变；锁定时隐藏恢复入口。
- 页面顶部锁按钮和恢复继承菜单可用；单空间跳转、空间切换、管理员与成员的空间菜单权限回归通过。
- 查询失败的拒写和不可见来源的隐藏由异常注入测试验证。没有停止共享数据库，也没有执行正式回滚。
- 测试页面及临时账号残留数均为 0，原文档内容、标题和保护设置的校验值保持一致；应用、数据库及 Redis 健康。

实际 `PageProtectionService.resolveMany` 在四层测试树上的查询耗时（各预热 5 次，再采样 50 次；包含数据库驱动往返）：

| 查询 | 每次 SQL 数 | 平均 | P95 |
| --- | --- | --- | --- |
| 最深叶页面 | 1 | 1.12 ms | 2.03 ms |
| 四个页面批量计算 | 1 | 0.57 ms | 0.75 ms |

这是本机小规模顺序采样，不代表大空间或高并发性能，也不是完整协作写入请求的耗时。
日志、截图和导出样本保存在 `data/local/protection-validation/shrink-20260917-202321/`。
本次迁移前备份位于 `data/local/backups/protection-20260917-184202/`。

## 部署与回滚

此变更只部署到上述本地环境，不自动更新 `10.0.1.70`。

升级前必须备份数据库并保留正在运行的镜像、Compose 配置和环境文件。本地备份目录位于 `data/local/backups/protection-*`，包含 `database.dump`、`image.txt`、`compose.yaml`、`.env` 和容器配置。附件卷原样复用。

旧镜像不执行保护检查，**仅回退镜像会失去保护约束**。正式回滚需在维护窗口停止所有应用和独立协作实例，并选择以下一种方式：

1. 恢复升级前数据库备份，恢复对应旧配置和镜像后启动。此方式会丢弃备份之后的数据库变更，必须先另存当前数据库和附件数据。
2. 保留当前文档，使用当前源码的 `migration:down` 回退本次迁移，再启动旧镜像。执行前确认本次迁移仍是最新迁移；若已有后续迁移，需要先制定完整回退顺序。此方式将继承值转为 `false`，删除版本列和通知触发器，不能保留保护继承语义。需预先导出所有页面的显式设置和版本用于后续恢复。

恢复备份的命令示例（在停止应用后执行，备份路径替换为实际路径）：

```bash
docker compose --env-file data/local/.env -f data/local/compose.yaml stop docmost
# 旧备份不包含新函数，先移除，避免遗留对象阻塞将来再次升级。
docker exec docmost-local-db-1 psql -U docmost -d docmost -v ON_ERROR_STOP=1 \
  -c 'DROP FUNCTION IF EXISTS page_protection_changed() CASCADE'
docker exec -i docmost-local-db-1 pg_restore \
  -U docmost -d docmost --clean --if-exists --exit-on-error \
  < data/local/backups/protection-YYYYMMDD-HHMMSS/database.dump
# 恢复备份目录中的 compose.yaml、.env，并使用 image.txt 中保留的旧镜像标签。
docker compose --env-file data/local/.env -f data/local/compose.yaml up -d --no-deps docmost
```
