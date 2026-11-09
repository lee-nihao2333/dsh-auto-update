# 发布指南：npm + GitHub

本文件记录 [`@marvinlee2011/dsh-auto-update`](https://www.npmjs.com/package/@marvinlee2011/dsh-auto-update) 的完整发布流程，包括首次发布时踩过的坑。以后发新版本照「发布检查清单」执行即可。

- npm 包：https://www.npmjs.com/package/@marvinlee2011/dsh-auto-update
- GitHub 仓库：https://github.com/lee-nihao2333/dsh-auto-update
- 当前版本：`1.0.0`

一次发布 = 改代码 → 升版本号 → 跑测试 → 打包验证 → push GitHub → `npm publish` → 线上验证。

## 1. 一次性准备

### 1.1 工具

| 工具 | 用途 | 检查命令 |
| --- | --- | --- |
| Node.js | 运行测试与发布 | `node -v`（要求 `^22.19.0 \|\| >=24.0.0`） |
| npm | 打包、发布 | `npm -v` |
| gh（GitHub CLI） | 创建仓库、推送 | `gh auth status` |

### 1.2 npm 发布认证（最容易卡住的一步）

npm 现在要求发布包时满足**任意一条**：

1. 账号开启 2FA（TOTP 验证器），发布时用 `--otp` 传验证码；
2. 使用带 **Bypass 2FA** 的 Granular Access Token。

本仓库采用第 2 种（不需要手机验证器）。

**创建令牌**（浏览器已登录 npm 后）：

1. 打开 https://www.npmjs.com/settings/marvinlee2011/tokens
2. 点 **Generate New Token → Granular Access Token**  
   ⚠️ 不要用 “Publish token” 快捷方式：它默认**不勾选** Bypass，发布时仍会 403。
3. Token name 随意（如 `dsh-auto-update publish`），Expiration 选 30/90 days
4. **勾选 “Bypass two-factor authentication (2FA)”**  
   位置：Description 下方、Allowed IP ranges 上方（页面标题为 *New Granular Access Token*）
5. Permissions 选 **Read and write (publish and stage)**
6. Packages and scopes 选 **All packages**
7. 滚到底部点 **Generate token**，复制只显示一次的 `npm_...` 令牌
8. 写入本机 npm 配置：

   ```sh
   npm config set '//registry.npmjs.org/:_authToken=npm_你的令牌'
   ```

9. 验证：

   ```sh
   npm whoami --registry https://registry.npmjs.org/
   # 应输出 marvinlee2011
   ```

注意事项：

- 令牌等同于发布密码，只放在 `~/.npmrc`，**不要提交到 Git、不要发到聊天或截图里**。
- 在 npm 网页上删除令牌后，本机下一次操作会立刻 `401`；重新创建并 `npm config set` 即可。
- `npm login --auth-type=web` 只解决「登录」，**不解决发布时的 2FA 要求**。
- 若账号已开 TOTP 2FA，也可以不建 bypass 令牌，直接：

  ```sh
  npm publish --access public --otp=<当前 6 位验证码>
  ```

### 1.3 GitHub 认证

```sh
gh auth status
# 需要 repo（创建/推送）与 workflow（若要加 CI）scope
# 本机账号：lee-nihao2333
```

提交身份用 GitHub noreply 邮箱：既能关联账号，又不暴露真实邮箱。

```sh
git config user.name "lee_nihao2333"
git config user.email "184731087+lee-nihao2333@users.noreply.github.com"
```

## 2. 包元数据（已配置，改动时参考）

`package.json` 关键字段：

```json
{
  "name": "@marvinlee2011/dsh-auto-update",
  "version": "1.0.0",
  "description": "Update button for the DeepSeek Harness (dsh): ...",
  "license": "MIT",
  "author": "marvinlee2011",
  "repository": { "type": "git", "url": "git+https://github.com/lee-nihao2333/dsh-auto-update.git" },
  "homepage": "https://github.com/lee-nihao2333/dsh-auto-update#readme",
  "bugs": { "url": "https://github.com/lee-nihao2333/dsh-auto-update/issues" },
  "keywords": ["dsh", "dsh-plugin", "deepseek-harness", "cordis", "cordis-plugin", "update", "updater", "plugin"],
  "engines": { "node": "^22.19.0 || >=24.0.0", "dsh": ">=0.2.1-rc.2 <0.3.0" },
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "client.js", "lib/*.js", "lib/*.mjs", "cordis.patch.yml", "locale/*.json", "icon.svg", "README.md", "LICENSE"],
  "publishConfig": { "access": "public", "registry": "https://registry.npmjs.org/" },
  "scripts": {
    "test": "node test/update.test.mjs && ... && node test/plugin.test.mjs",
    "prepublishOnly": "npm test"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-conversation"] }
  }
}
```

要点：

- `files` 决定 npm 包内容；`test/` 不进包，但保留在 GitHub 仓库里。
- `publishConfig.registry` 保证即使本机 registry 是镜像（如 npmmirror），`npm publish` 也发到 npmjs。
- `engines.dsh` 是 DSH 的插件兼容范围（DSH 用 `includePrerelease` 判断，`0.2.1-rc.2` 这类预发布也能通过）。
- `prepublishOnly` 在每次 publish 前自动跑测试，测试失败会中止发布。
- 包里的 `client.js` 模块 id、`cordis.patch.yml` 的 `name` 必须与 `package.json` 的 `name` **完全一致**，改名时三处一起改。

### 包名规则

- 先查可用性（404 = 可用）：

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/<包名>
  ```

- npm 会拒绝与已有包「过于相似」的名字：例如 `dsh-auto-update` 因已有 `dsh-autoupdate` 被 403 拒绝，npm 自己也建议改用作用域包名。
- 被拒绝时优先用自己 scope 的包名，必然可用：`@marvinlee2011/<名字>`。

## 3. 发布前检查

```sh
cd dsh-update
node --check index.js
node --check client.js
for f in lib/*.js lib/*.mjs; do node --check "$f"; done
npm test
npm pack --dry-run    # 核对包内容：14 个文件，不含 test/
```

用真实 tarball 做一次隔离安装验证：

```sh
npm pack --pack-destination /tmp
rm -rf /tmp/pkg-check && mkdir /tmp/pkg-check && cd /tmp/pkg-check
npm init -y >/dev/null
npm install /tmp/marvinlee2011-dsh-auto-update-1.0.0.tgz
node -e "import('@marvinlee2011/dsh-auto-update').then(m => console.log(m.name, typeof m.apply, m.inject))"
```

## 4. 发布到 GitHub

首次（已经完成，供参考）：

```sh
cd dsh-update
git init -b main
git add -A
git commit -m "feat: dsh-auto-update 1.0.0 — update button for the DeepSeek Harness"
gh repo create dsh-auto-update --public --source=. --remote=origin --push \
  --description "Update button for the DeepSeek Harness (dsh): checks npm for a newer dsh, installs it and restarts dsh."
gh repo edit lee-nihao2333/dsh-auto-update \
  --add-topic deepseek-harness,dsh,dsh-plugin,update,cordis-plugin
```

以后每次更新：

```sh
git add -A
git commit -m "feat: <改动说明>"
git push
```

建议同时打 tag / 建 Release（可选）：

```sh
git tag v1.0.1
git push --tags
gh release create v1.0.1 --generate-notes
```

## 5. 发布到 npm

```sh
cd dsh-update
npm version patch     # 1.0.0 → 1.0.1；会自动 commit + tag，不想自动提交用 --no-git-tag-version
npm publish --access public
```

- `publishConfig` 已指定 npmjs，不必额外加 `--registry`。
- `prepublishOnly` 会先跑 `npm test`。
- 看到 `+ @marvinlee2011/dsh-auto-update@1.0.1` 即成功；npm 页面与镜像同步可能需要几十秒到几分钟。

验证：

```sh
npm view @marvinlee2011/dsh-auto-update version --registry https://registry.npmjs.org/

# 从 registry 真实安装
rm -rf /tmp/reg-check && mkdir /tmp/reg-check && cd /tmp/reg-check
npm init -y >/dev/null
npm install @marvinlee2011/dsh-auto-update
node -e "import('@marvinlee2011/dsh-auto-update').then(m => console.log(m.name))"
```

> 首次发布时版本列表里会出现一个 `0.0.0-stage`，那是 npm staged publishing 的占位版本，私有且无害；`latest` 指向真实版本即可。

## 6. 常见错误速查

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `403 ... Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages` | 账号没开 2FA，且令牌没勾 Bypass | 重建 granular token 并勾选 Bypass 2FA；或开 TOTP 2FA 后用 `--otp` |
| `403 Package name too similar to existing package ...` | 包名与已有包过于相似 | 改用 `@marvinlee2011/...` 作用域包名 |
| `401 Unable to authenticate, your authentication token seems to be invalid` | 令牌被删除或过期 | 重新创建令牌并 `npm config set` |
| `403 You cannot publish over the previously published versions` | 版本号没升 | 先 `npm version patch` 再发 |
| `prepublishOnly` 失败 | 测试或语法错误 | 按 `npm test` 输出修复后再发 |
| npm 页面 403/404 | 页面/镜像同步延迟 | 等 1–5 分钟，或直接查 `registry.npmjs.org` |
| GitHub push 被拒 | 未登录或缺少 scope | `gh auth login`，确认有 `repo` scope |

## 7. 回滚与撤销

- npm 同一版本号不能覆盖，只能升版本重发。
- 发布 72 小时内可 `npm unpublish @marvinlee2011/dsh-auto-update@<version>`；超过 72 小时建议用 `npm deprecate` 标记，而不是删包。
- GitHub 侧用 revert 或新 commit 回滚，必要时用 `git tag` 标记历史版本。

## 8. 发布检查清单

- [ ] 代码改动完成，`npm test` 全部通过
- [ ] `package.json` 版本号已升（`npm version patch|minor|major`）
- [ ] README / 描述与实际功能一致
- [ ] `npm pack --dry-run` 内容正确（无测试、密钥或多余文件）
- [ ] `git commit` + `git push`（可选打 tag）
- [ ] `npm publish --access public`
- [ ] `npm view ... version` 确认线上版本
- [ ] 从 registry 装一次，确认能正常加载
- [ ] （可选）GitHub Release / Release Notes

## 9. 本地开发安装（补充）

改代码时不必每次发布，可直接把本目录以 link 方式装进当前 profile（DSH 插件管理器 `install_bundle`，target 传本目录绝对路径）。link 安装时 Node 按真实路径解析模块，本插件不依赖 dsh 安装目录里的包，因此没有额外依赖；改完 Host/Client 代码后重启 `dsh web` 生效。
