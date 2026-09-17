# 页面保护锁

页面保护是所有协作者共享的持久化设置。页面顶部的锁图标切换显式锁定／解锁，旁边小箭头菜单用复选框控制继承：子页面显示“继承父页面”，根页面显示“使用空间默认设置”，并说明空间当前默认锁定或解锁。勾选恢复继承，取消勾选保持当前实际状态并转为显式设置。复选框仅在无管理保护权限或提交期间禁用。菜单和提示文字区分本页显式设置、继承状态和空间默认值；没有来源页面访问权限时不返回其名称和 ID。

未配置的已有空间和新空间均默认锁定根页面，新建页面默认继承。空间设置的“设置”页在基本信息表单下提供“根页面默认锁定”开关，修改后即时保存，仅空间设置管理员可修改，不需要企业授权。保存失败后重新读取服务端真实状态。

沿当前祖先链向上查找，最近的显式设置生效。例如 A 锁定、B 继承、C 显式解锁，C 及继承 C 的后代可以编辑；再次切换 A 不会改写 C 的设置。

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

空间默认值保存在 `spaces.settings.pageProtection.rootDefaultLocked`，缺省为 `true`；同一对象的 `version` 缺省为 `0`，由服务端在默认值实际变化时递增，重复保存相同值不递增。通过原有 `POST /api/spaces/update` 提交 `{ "spaceId": "空间 UUID", "rootDefaultLocked": false }`。接口只接受布尔值，不接受客户端指定版本，并保留其他空间设置；无需新增表、列或迁移。

默认值变更立即影响所有未被自身或祖先显式设置覆盖的已有、新建页面，不批量改写页面记录。跨空间移动后使用目标空间默认值。页面详情的 `protection.rootDefaultLocked` 返回已解析的空间默认值。

`protection_version` 由数据库触发器递增，覆盖设置、父页面、空间和删除状态的实际变化。有效版本是固定标识 `space-root-default-v1`、空间保护版本及完整祖先链中页面 ID、版本和空间 ID 的 MD5 摘要，仍返回 32 位十六进制字符串。因此移出后移回、祖先上锁后解锁、空间默认值关闭后再开启都产生不同版本，即使最终锁状态相同。

页面接口的 `isLocked` 始终是最终状态的布尔值，显式设置从 `protection.mode` 读取。页面树通过一次批量祖先查询计算返回页的状态，不逐页查询祖先。复制时复制各节点的原始显式设置；移动和回收站恢复后按实际位置计算继承。

```json
{
  "pageId": "页面 UUID",
  "mode": "inherit",
  "version": "页面详情返回的 protection.version"
}
```

通过 `POST /api/pages/protection` 提交上面的请求。`mode` 支持 `inherit`、`locked`、`unlocked`。服务端验证工作区、访问权限和原有编辑权限，并在空间层级事务锁内比较版本、更新本页设置。版本过期返回 `409`，客户端重新获取状态后由用户决定是否重试。

空间默认值更新事务首先取得与页面移动和保护设置相同的空间层级锁，再锁定空间记录、更新 JSON 设置和版本，并调用现有 `page_protection` 通知。

数据库事务提交后通过 PostgreSQL `NOTIFY` 向应用发送旧／新空间 ID，应用再广播 `pageProtectionInvalidated`。通知不包含页面名称或内容。浏览器收到通知或重新连接时重新查询有权访问的页面、页面树和空间设置；协作写入正确性不依赖通知及时到达。保护订阅还会刷新已加载但没有活动查询订阅的子节点查询，并将根节点和子节点的最新锁状态写入页面树，保留原有树结构和展开状态。

## 断线与本地恢复

协作认证携带页面保护版本，重连不能把旧文档自动绑定到新版本。浏览器的 IndexedDB 文档按页面和保护版本隔离。旧版本文档不会合并进新版本；启用此功能前未带版本的旧缓存也不会自动导入。

正文的未确认修改和标题的延迟保存内容另存为本地恢复副本。标题请求使用编辑发生时的版本；发生保护变化时，旧请求不会借用新版本提交。恢复副本提供复制、Markdown 导出和丢弃操作，保存在当前浏览器，不上传服务器，不在解锁后自动重放。已收到服务端确认的当前副本可清除。

有效版本包含空间保护版本和完整祖先链，因此空间默认值或上级变化可能令显式解锁页面也切换协作版本。其最终解锁状态不变，未确认修改仍按版本变化规则保留。

## 上游集成边界

保护锁通过独立服务、控制器和前端 Hook 接入，上游文件保留权限检查调用、Hook 调用及模块注册。

| 独立实现 | 职责 |
| --- | --- |
| `core/page/protection/` | 设置接口、祖先状态计算、响应字段及来源可见性 |
| `collaboration/services/collaboration-protection.service.ts` | 协作认证版本与同步前拒写检查 |
| `features/editor/use-collaboration-protection.tsx` | 版本隔离、协作只读状态和正文恢复副本 |
| `features/editor/use-title-protection.ts` | 标题修改的版本绑定、确认和恢复副本 |
| `features/page/hooks/use-page-protection-subscription.ts` | 页面、页面树、空间设置失效与重连后的重新查询 |
| `features/space/components/space-page-protection-settings.tsx` | 空间默认保护开关及即时保存 |
| `ws/page-protection.bridge.ts` | 数据库事务提交后的空间通知 |

历史恢复使用原有的编辑器命令和标题同步流程；等待历史内容期间保护版本变化时中止恢复。
回收站恢复保留原有主体逻辑，由事务包装统一层级锁和提交后通知。复制仅增加显式保护设置的保留。

## 本地验证

使用 `data/local/compose.yaml` 的现有应用、PostgreSQL、Redis 和附件卷，地址为 <http://192.168.1.60:3010>。本地镜像名为 `docmost-local:space-root-default`。

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

本地浏览器脚本使用现有管理员创建两个临时测试空间及临时空间管理员、编辑、只读和非成员账号。默认值开关测试只在临时空间执行，不修改真实空间配置或现有账号权限；测试空间、页面和账号在结束时清理，并校验原文档未变化。截图及导出文件默认保留在 `/tmp/docmost-protection-validation`。

数据库查询失败的拒写行为由权限服务和协作钩子测试注入异常验证，不通过停止共享数据库制造故障。

## 本地验证结果（2026-09-17）

运行镜像为 `docmost-local:space-root-default`，镜像 ID 为 `sha256:2f86dcc61fde79b933f10e229df6cbf6c5fc1f7c845d095d256d630e43d63731`。

- 工作区构建、客户端 TypeScript 检查和 24 项后端测试通过。
- 临时空间验证通过：缺省锁定、不同空间默认值、多层继承、显式覆盖、新建与跨空间移动、重复及并发保存、版本冲突、其他配置保留和页面记录不被批量改写。
- 临时空间管理员可即时保存，编辑成员、只读成员及非成员不能越权修改；模拟保存失败后开关显示服务端状态。
- 双浏览器验证通过：根页面／子页面继承复选框、页面与空间默认值变更后的侧栏锁图标、保留展开状态、设置开关同步、断线重连、恢复副本复制／导出、延迟标题冲突和禁止旧修改自动重放。
- 实际 PostgreSQL 事务验证通过：回滚不改变配置及有效版本、不发通知，提交后才收到通知；评论和历史恢复回归通过。
- 最后一轮测试空间、页面和账号残留均为 0；原文档、真实空间配置和既有成员权限的前后校验一致。应用、数据库和 Redis 健康。未执行正式部署回滚或主机重启验证。

日志、截图和导出样本位于 `data/local/protection-validation/space-root-default-20260917-210548/`，升级前备份位于 `data/local/backups/space-root-default-20260917-204845/`。原数据快照校验要求测试期间没有其他客户端同时修改原文档或配置。

## 部署与回滚

此变更只部署到上述本地环境，不自动更新 `10.0.1.70`。

空间默认设置不增加数据库迁移。升级后未配置空间的继承根页面立即锁定；页面显式状态保留。版本摘要的固定标识使升级前旧缓存不能自动进入新协作版本，未确认修改保留为本地恢复副本。

升级前必须备份数据库并保留正在运行的镜像、Compose 配置和环境文件。本地备份目录位于 `data/local/backups/space-root-default-*`，包含 `database.dump`、`image.txt`、`compose.yaml` 和 `.env`。附件卷原样复用。

回退到仅支持页面保护的旧版本（不含空间默认设置）时，不需要执行 `migration:down`，但旧版本忽略空间默认设置，继承根页面恢复默认解锁。必须在维护窗口停止全部应用／协作实例，导出空间设置、保留当前备份后再使用保留的镜像及配置；不要把回退前的离线修改自动导入旧版本。再次升级时保留的空间默认值和版本继续生效。

下述迁移回退步骤仅适用于退回完全不支持页面保护的版本。旧镜像不执行保护检查，**仅回退镜像会失去保护约束**。正式回滚需在维护窗口停止所有应用和独立协作实例，并选择以下一种方式：

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
