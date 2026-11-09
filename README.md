# dsh-auto-update

[![npm](https://img.shields.io/npm/v/@marvinlee2011%2Fdsh-auto-update?label=npm&color=cb3837)](https://www.npmjs.com/package/@marvinlee2011/dsh-auto-update)
[![GitHub stars](https://img.shields.io/github/stars/lee-nihao2333/dsh-auto-update?label=GitHub&color=181717)](https://github.com/lee-nihao2333/dsh-auto-update)

npm 包名：**[`@marvinlee2011/dsh-auto-update`](https://www.npmjs.com/package/@marvinlee2011/dsh-auto-update)** · GitHub：**[lee-nihao2333/dsh-auto-update](https://github.com/lee-nihao2333/dsh-auto-update)**

DeepSeek Harness（`dsh`）的更新按钮插件：当 npm registry 上出现比本机更新的 `dsh` 版本时，在会话标题栏右上角显示一个「更新」按钮；点击后用 npm 全局安装新版本并重启 `dsh`，页面在新进程就绪后自动刷新。

An update button for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): when a newer `dsh` is on the npm registry, a top-right **Update** pill appears in the session header. One click installs that version globally and restarts `dsh`; the page reloads once the new process answers.

- 无构建步骤、无运行时依赖（Host 侧只用 Node 内置模块）。
- 只在 Web profile 生效，走与内置 `/api` 相同的 Host/Origin 校验与浏览器认证。
- 只在确实存在更新时显示按钮；不会静默升级。

## 安装

### 方式一：插件管理器（推荐）

1. 打开 DSH Web → **设置 → 插件**。
2. 点击 **安装第三方插件**，输入包名 `@marvinlee2011/dsh-auto-update` 并确认。
3. 插件出现在列表中并启用后，刷新页面。

插件管理器会同时把包装进 profile、把 bundle 加入启动列表并启用它。

### 方式二：命令行

```sh
dsh plugin --profile web add @marvinlee2011/dsh-auto-update
```

然后把包名加到 profile 的启动列表 `~/.dsh/profiles/web/package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@marvinlee2011/dsh-auto-update"
      ]
    }
  }
}
```

重启 `dsh web`。`dsh plugin add` 只负责安装依赖，不会自动把 bundle 加入启动列表；漏掉这一步时启动日志会提示 bundle 未启动。

### 环境要求

- dsh `0.2.1-rc.2` 及以上、`0.3.0` 以下版本（`engines.dsh`，预发布版本也算入范围）。
- Node.js `^22.19.0 || >=24.0.0`（与 dsh 一致）。
- 当前用户对 npm 全局前缀有写权限（nvm / nodenv / 自建 prefix 通常满足）——升级动作由插件以当前用户身份执行 `npm install --global`。

## 使用

1. 打开一个会话，标题栏右上角工具区最右侧会显示「更新」（英文界面为 “Update”）。
2. 悬停可看到「当前版本 → 目标版本」。
3. 点击后按钮依次显示「正在更新…」「正在重启…」，随后页面自动刷新。

按钮只在以下情况出现：registry 上 `dist-tag` 指向的版本高于本机版本；或上次安装成功但重启未完成（此时显示「重启」）。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖插件行，然后重启 `dsh`：

```yaml
- id: dsh-auto-update
  name: '@marvinlee2011/dsh-auto-update'
  config:
    packageName: '@deepseek-ai/dsh'  # 要升级的包
    distTag: latest                  # 比较的 dist-tag
    registry: ''                     # 空 = 沿用 npm 自身的 registry 配置
    checkIntervalMinutes: 30         # 自动检查间隔，1–1440
```

常用场景：

- **想跟进预发布版本**：把 `distTag` 改成 `next` 或 `alpha`（取决于目标包实际发布的标签）。
- **降低检查频率**：调大 `checkIntervalMinutes` 即可；页面每次打开仍会显示当前状态。
- **镜像 / 私有 registry**：留空时插件执行 `npm config get registry`；也可以直接写死 `registry`。

调整 `distTag` 后，点击「更新」安装的是该标签当时的版本，安装前会重新解析并固定到精确版本。

## 行为与安全

- 检查只读取 registry 的 packument（`dist-tags`），不改动磁盘；默认启动时检查一次，之后每 30 分钟一次，页面每 60 秒读取一次 Host 状态。
- 三个接口都经过与内置 `/api` 相同的 Host/Origin 校验和浏览器认证：`GET /dsh-auto-update/status`、`POST /dsh-auto-update/apply`、`POST /dsh-auto-update/restart`。页面无法指定包名、版本或命令。
- 安装使用精确版本（如 `@deepseek-ai/dsh@0.2.2`），安装后重新读取磁盘上的 `package.json` 核对版本；不一致则**不重启**并报告错误。
- 重启由一个独立脚本完成：它等待当前进程退出，再用相同的 node、启动脚本、参数和工作目录拉起 `dsh`；当前进程通过 `appExit` 优雅退出。
- 安装失败时按钮变为「重试更新」，不会重启；重启失败时变为「重启」，可单独重试。
- 状态与日志（诊断用）：

  ```
  <DSH_HOME>/cache/dsh-auto-update/state.json    # 最近一次检查与阶段
  <DSH_HOME>/cache/dsh-auto-update/restart.log   # 重启脚本输出
  <DSH_HOME>/cache/dsh-auto-update/restart.json  # 最近一次重启记录
  ```

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 右上角没有按钮 | ① 当前没有更新（`latest` 等于已装版本）——用 `npm view @deepseek-ai/dsh dist-tags` 核对；② 没有打开会话（按钮在会话标题栏）；③ 页面尚未加载插件，刷新一次。 |
| 一直不出现按钮，但 registry 明明有新版本 | 默认只比较 `latest`；预发布版本在 `next`/`alpha` 上，需要按上文配置 `distTag`。 |
| 点击后提示更新失败 | 多为 npm 全局前缀无写权限或 registry 不可达。查看 `state.json` 的 `error`，或在终端手动执行状态里记录的 `npm install --global ...` 验证。 |
| 安装成功但页面没回来 | 查看 `restart.log`；如果新版本启动失败，用原来的 `dsh web` 命令手动启动，旧版本文件不会被删除。 |
| 改了配置没生效 | 配置在插件激活时读取，修改 `cordis.patch.yml` 后需要重启 `dsh`（或在插件管理器中重载插件）。 |

## 卸载

插件管理器 → 插件 → 停用/移除；或：

```sh
dsh plugin --profile web remove @marvinlee2011/dsh-auto-update
```

并从 profile 的 `dsh.profile.bundles` 中删除 `@marvinlee2011/dsh-auto-update`，重启 `dsh web`。

## 开发

包内自带 34 项检查（版本比较、registry、状态机、路由契约、重启交接、真实 Host wiring）：

```sh
npm test
```

本地开发安装（link 方式）：把本目录的绝对路径交给 DSH 的插件管理器（`plugin_manager` 的 `install_bundle`）即可。link 安装时 Node 按真实路径解析模块，本插件不依赖 dsh 安装目录里的包，因此无需额外依赖。

发布流程（npm + GitHub，含认证、命名规则与常见报错）见 **[RELEASING.md](RELEASING.md)**。

## 许可

[MIT](LICENSE)。与 DeepSeek 官方无关（not affiliated with DeepSeek）。
