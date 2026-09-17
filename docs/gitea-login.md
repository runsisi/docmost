# Gitea 登录

本实现面向自托管 Docmost，通过 Gitea 的 OpenID Connect 授权码流程登录。
它使用社区版的用户、默认用户组和会话管理，不依赖企业版 SSO 模块或许可证功能开关。
同一实例配置一个 Gitea 身份提供方。

## 配置

在 Gitea 的「用户设置 → 应用 → 管理 OAuth2 应用」中创建机密客户端应用，
将回调地址设为 `${APP_URL}/api/auth/gitea/callback`。
例如，浏览器通过 `http://192.168.1.60:3010` 访问时，设置
`APP_URL=http://192.168.1.60:3010`，并登记回调地址
`http://192.168.1.60:3010/api/auth/gitea/callback`。
`HOST=0.0.0.0` 仅控制监听地址，不改变 `APP_URL` 或 Gitea 中登记的回调地址。
更换访问地址时必须同步修改这两项，且应从新地址重新发起登录。

| 环境变量 | 含义 | 默认值 |
| --- | --- | --- |
| `GITEA_ENABLED` | 启用独立 Gitea 登录 | `false` |
| `GITEA_ISSUER` | Gitea discovery 文档中的 `issuer`，例如 `http://git.xcube.com` | 无 |
| `GITEA_CLIENT_ID` | OAuth2 应用 Client ID | 无 |
| `GITEA_CLIENT_SECRET` | OAuth2 应用 Client Secret | 无 |
| `GITEA_ALLOW_SIGNUP` | 允许没有绑定的新身份创建本地成员账号 | `false` |

启用时必须配置完整的 issuer 和凭据。支持 HTTP 和 HTTPS issuer；服务器必须能够访问
discovery、token、JWKS 和 UserInfo 接口，浏览器必须能访问 Gitea 授权页和 Docmost 回调地址。
`APP_URL` 必须与浏览器访问地址一致，绑定接口会检查请求 Origin。

## 使用方式

已有 Docmost 用户先使用原有方式登录，在「设置 → 我的资料」中点击「绑定 Gitea 账号」，
在 Gitea 同意授权后完成绑定。随后可以退出，在登录页点击「使用 Gitea 登录」。
现有用户的角色、工作区成员关系和邮箱不会因绑定而改变。

自动注册关闭时，未绑定身份会收到先登录并绑定的提示。
开启自动注册后，新身份需要提供 Gitea 已验证的有效邮箱，并满足工作区允许的邮箱域名要求。
新用户以普通成员身份加入工作区默认用户组，不从 Gitea 管理员身份或组织身份推导权限。
若邮箱已被现有账号使用，必须先登录该账号并主动绑定，不能凭相同邮箱自动合并。

工作区或用户启用 Docmost MFA 时，独立 Gitea 登录不会跳过 MFA，而是提示使用原有登录方式。
本实现不提供 Gitea 组织/团队权限同步、解绑管理界面或多身份提供方配置界面。

## 认证和数据

登录请求使用 `openid email profile`，验证 `state`、`nonce`、PKCE S256、ID token 签名以及
UserInfo 的 subject。登录上下文保存在 Redis 中，有效期为十分钟，回调时原子取出并删除。
浏览器仅保存 HttpOnly、SameSite=Lax 的随机流程 cookie。
绑定还要求发起绑定的本地用户会话仍然有效，且回调浏览器持有同一会话 cookie。

`gitea_accounts` 保存 `workspace_id`、`user_id`、`issuer` 和 `subject`。
每个工作区内一个外部身份只能绑定一个本地用户，一个本地用户在同一 issuer 下只能绑定一个身份。
首次创建用户、加入默认组和写入绑定在同一数据库事务中完成；并发回调由事务锁和唯一约束保护。
已经绑定的身份通过 `issuer + sub` 定位用户，后续外部邮箱变化不会自动转移绑定。
停用或软删除的用户不能登录，软删除不会释放已有 Gitea 身份绑定。

认证成功后调用现有的 `SessionService.createSessionAndToken()` 创建 Docmost 会话。
Gitea access token 不写入数据库，也不用于后续文档请求。退出登录撤销 Docmost 会话，
不会退出用户在 Gitea 中的会话。

## 构建和验证

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --filter server exec jest --runInBand gitea
docker build --network=host -t docmost-local:gitea .
```

`apps/server/test/gitea-accounts.integration.cjs` 用真实 PostgreSQL 验证并发注册、
角色、默认组、邮箱冲突、绑定冲突、注册开关和停用账号。
在 `apps/server` 目录运行，`DATABASE_URL` 必须指向名称以 `_test` 结尾的独立测试库，
并已通过 `/api/auth/setup` 初始化工作区：

```bash
DATABASE_URL=postgresql://user:password@localhost/docmost_gitea_test \
  node test/gitea-accounts.integration.cjs
```
