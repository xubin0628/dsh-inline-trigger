# dsh-inline-trigger

> 让 DSH Web 输入框在**已有内容**时也能用 `/` 唤起指令菜单、用 `@` 唤起「文件 / 会话」引用菜单 —— 包括紧跟在中文等非 ASCII 文字之后输入的情况。

[![test](https://github.com/xubin0628/dsh-inline-trigger/actions/workflows/test.yml/badge.svg)](https://github.com/xubin0628/dsh-inline-trigger/actions/workflows/test.yml)
[License: MIT](LICENSE)

原生 DSH 的触发规则（`@deepseek-ai/dsh-client-ui-input-trigger`）只认三种位置：

- 输入框最前面；
- 空格（含换行）之后；
- 对 `/` 额外允许：标点之后（URL 里的 `:/`、`//` 除外）。

所以 `你好/`、`你好@`、`总结一下@文件` 这类**紧跟在中文后面**的输入不会弹出菜单 —— 中文本来就不习惯敲空格，于是看起来就变成「只有输入框为空时 `/` 和 `@` 才有用」。本插件就是补上这一格。

## 安装

### 直接下载 zip（免 git）

从 [Releases](https://github.com/xubin0628/dsh-inline-trigger/releases/latest) 下载 `dsh-inline-trigger-1.0.1.zip` 并解压，然后在 DSH 会话里让 agent 安装该目录：

```
plugin_manager install_bundle { target: "<解压目录绝对路径>" }
```

### 从 GitHub 克隆后安装（推荐）

```bash
git clone https://github.com/xubin0628/dsh-inline-trigger.git
```

然后在 DSH 会话里让 agent 安装这个目录（把路径换成实际克隆位置）：

```
plugin_manager install_bundle { target: "<克隆目录绝对路径>" }
```

或者用 CLI：

```bash
dsh plugin --profile desktop add link:<克隆目录绝对路径>
```

装好后插件出现在「设置 → 插件」里，页面会自动同步，不需要重启。

### 本地开发目录安装

直接在插件源码目录执行同样的 `plugin_manager install_bundle`（`target` 指向源码目录）即可；profile 会以链接方式引用该目录，改完代码后页面热重载生效。

## 兼容性

已在 **DSH 0.2.2-rc.3** 上逐个核对过它依赖的上游面，结论是**接口未变、无需改写**：

| 依赖的上游面 | 0.2.2-rc.3 现状 |
|---|---|
| `ctx.inject(['inputTriggers'])` + `ctx.get('inputTriggers')` | 服务仍在，`InputTriggerService` 是普通 class（非可调用服务），`Object.getPrototypeOf(service)` 就是它的原型 |
| `InputTriggerService.sessionOf(actx)` | 签名未变；会话 composer 仍通过 `rootCtx.get('inputTriggers').sessionOf(actx)` 取控制器 |
| `InputTriggerController.track(draft, caret, guard, draftRev)` | 仍是 4 个参数，`guard.tier` 仍是 `plain / claimed / frozen`，调用点仍传 `projection.detectText` 与真实 `rev` |
| `InputTriggerController.pick(source, index, action)` | 仍是 3 个参数；`action` 省略即「落选」，`'drill'` 即「进入文件夹」，`MenuView` 的行点击省略它、行尾箭头显式传 `'drill'` |
| `core/detect.ts` 的边界规则 | 与 `test/detection.test.mjs` 里原样抄录的那份逐条一致（含 `@"..."` 引号语法来自 `@deepseek-ai/dsh-file-reference/grammar`） |
| 客户端注册格式 `window.__ModuleLoader__.load({ id, factory })` | 现役格式；`id` 必须等于包名，本包一致 |
| `dsh.client.platform / immediately / inject` | 仍在 `parseDshClient()` 的校验范围内 |

`package.json` 现在显式声明了兼容范围：

```json
"engines": { "dsh": ">=0.2.2-rc.1 <0.3.0" }
```

DSH 的兼容性判定先读 `engines.dsh`（`semver.satisfies(..., { includePrerelease: true })`，所以 rc 版也能命中）；
不满足时它会把这条 entry 禁用并告警，而不是带着不匹配的版本继续跑。升到 0.3 之后请重新核对再放宽这个范围。

上游若把边界规则放宽（例如允许任意字符后触发），本插件会自动退化为纯直通，不需要改代码。

## 生效范围

| 输入 | 原生 DSH | 装插件后 |
| --- | --- | --- |
| `/model`（空输入框） | ✅ | ✅（不变） |
| `hello /model`（空格后） | ✅ | ✅（不变） |
| `你好/`（中文后） | ❌ | ✅ |
| `总结一下/`（中文后） | ❌ | ✅ |
| `参考@会话`（中文后） | ❌ | ✅ |
| `你好，@文件`（中文标点后） | ❌ | ✅ |
| `a@b.com`（邮箱） | ❌ | ❌（保护） |
| `src/index.ts`（路径） | ❌ | ❌（保护） |
| `https://example.com/@u` | ❌ | ❌（保护） |

规则一句话：**`/` 只在非 ASCII 文字（中文、日文、韩文、西里尔、带音标拉丁等）后面放宽；`@` 在除 ASCII 字母/数字/下划线、`/`、`:`、`@` 以外的任意非空白字符后面放宽。** 这样既解决中文输入的问题，又不会在邮箱、路径、URL 里乱弹菜单。

## 文件夹：点一下就进去

工作区里的东西常常都在文件夹里，而原生 `@` 菜单要进一层只能按 **Tab** 或点行尾那个小箭头；**单击文件夹所在的那一行**是把 `@文件夹/` 插进输入框并把菜单关掉。只用鼠标的人因此一直在「列出来的文件夹」和「文件夹里的内容」之间来回：点一次就选中了文件夹，想看里面还得再想办法。

装上本插件后：

| 操作（在 `@` 菜单里） | 原生 DSH | 装插件后 |
| --- | --- | --- |
| 单击文件夹行 | 插入 `@文件夹/`，菜单关闭 | **进入该文件夹，菜单保持打开并列出内容** |
| 单击行尾箭头 | 进入文件夹 | 不变 |
| 高亮文件夹行后按 Tab | 进入文件夹 | 不变 |
| 高亮文件夹行后按 Enter | 插入 `@文件夹/`，菜单关闭 | 不变 |

也就是说两种能力并存：**鼠标点就往下看，回车就把整个文件夹当成一个引用收下**。文件夹可以一层层点下去，每一层里的文件或文件夹都能选。

插件怎么区分两者：`MenuView` 用 `mousedown` 落选、用键盘仲裁处理 Enter/Tab；插件在 `document` 上以捕获阶段监听 `pointerdown` / `keydown`，只记一个先后标志，鼠标落在文件夹行上时把这次落选升级成该行的「进入」动作。监听器不改编辑器 DOM、不拦截任何事件；插件卸载时对被包装的 `pick()` 完整还原。

已触发菜单之后的一切行为（键盘选择、引用 chip 插入、`/` 指令的 popup / 动作 / 直接执行、Esc 关闭、IME、只读/命令 chip 阶段）都沿用 DSH 原生实现，本插件只影响「是否判定为触发」和上面这一次「点击文件夹」的落选语义：

- 输入框最前已经有一条命令 chip（`claimed` 阶段）时，`/` 仍不触发（与原生一致）；
- `frozen` 阶段（提交中等）不触发；
- 关闭插件（或 HMR 卸载）时，对 DSH 的包装会完整还原。

## 可选项：更激进的边界

默认模式（`cjk`）保留邮箱与代码路径保护。如果你希望「任何非空白字符后面输入 `/` 或 `@` 都弹菜单」，在页面控制台执行一次：

```js
localStorage.setItem('dsh-inline-trigger:mode', 'always'); // 改回默认：localStorage.removeItem('dsh-inline-trigger:mode')
```

然后刷新页面（或等插件热重载）。代价很直接：`a@b.com`、`src/index.ts` 这类输入也会弹菜单，`https://` 除外（协议里的 `:/`、`//` 始终不触发）。

## 它怎么工作（给维护者）

DSH 的触发判定在 `InputTriggerController.track()` 内部，插件无法通过注册 trigger source 改变它。因此本插件：

1. 注入 `inputTriggers` 服务，包装它的 `sessionOf()`，从而拿到每个会话的 `InputTriggerController` 并包装其 `track()`；
2. 在把 draft 交给原生判定之前，生成一个**长度完全相同**的「影子 draft」：只把触发符前面那一个字符替换成边界字符（`@` 前换成空格、`/` 前换成 `、`）；
3. 原生 `detectTrigger()` 在影子 draft 上判定成功；由于替换发生在 token span 之前且不改变长度，`trigger / query / span {start,end} / position` 与真实 draft 完全一致，之后的选择、插入、命令 claim、token 消费都用真实偏移和真实 draftRev 工作；
4. 真实编辑器内容从不被修改。

这是一个针对已安装 DSH 版本行为的小包装（不修改编辑器 DOM、不 require 任何 Harness 客户端包）。升级 DSH 后如果上游把边界规则改宽了，本插件会自动变成「什么都不做」的纯直通。

## 测试

```bash
node test/detection.test.mjs
```

测试会把 `client.js` 的真实工厂函数加载起来，并用从当前 DSH 安装包里原样复制的 `detectTrigger()` 判定影子 draft，覆盖中文/日文/西里尔、邮箱与 URL 保护、`always` 模式、`frozen`/`claimed` 阶段、补丁安装与卸载还原。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半边：空 `apply()`，只为了让包成为一条 Loader entry |
| `client.js` | 浏览器半边：影子 draft 判定 + `track()` 包装 |
| `cordis.patch.yml` | bundle 挂载声明（插入一条 row） |
| `locale/zh.json`、`locale/en.json` | 插件管理页的标题与描述 |
| `icon.svg` | 插件图标（原创） |
| `test/detection.test.mjs` | 自包含回归测试 |

## English

**dsh-inline-trigger** makes the DSH Web composer open the `/` command menu and the `@` file/session reference menu even when the draft already contains text — most importantly right after CJK text, where a space is not normally typed.

The shipped trigger pipeline (`@deepseek-ai/dsh-client-ui-input-trigger`) only accepts a trigger at start-of-draft, after whitespace, or (for `/`) after punctuation. This plugin wraps the per-session `InputTriggerController.track()` and feeds the host a same-length *shadow draft* where only the character before the trigger is replaced by a boundary character. Detection succeeds while the real span/query/revision stay identical, so picks, chips, command claims and token consumption keep working; the real editor content is never touched.

```bash
git clone https://github.com/xubin0628/dsh-inline-trigger.git
# then, in a DSH session: plugin_manager install_bundle { target: "<abs path to the clone>" }
```

| Input | DSH | with plugin |
| --- | --- | --- |
| `你好/` | ❌ | ✅ |
| `参考@会话` | ❌ | ✅ |
| `a@b.com`, `src/index.ts`, `https://…` | ❌ | ❌ (deliberate protection) |
| click a folder row in the `@` menu | inserts `@folder/`, menu closes | **enters the folder, menu stays open** |

The shipped `@` menu lets a directory be reached only with Tab or the row's trailing chevron; a plain click settles `@folder/` and closes the menu, so a pointer-only user never gets into the folder. The plugin wraps `InputTriggerController.pick()`: a pick that began with a pointer press and whose row carries `drill` is promoted to the row's drill action. Enter keeps its meaning, so a folder stays referenceable as one atomic mention while a click descends into it.

Set `localStorage['dsh-inline-trigger:mode'] = 'always'` in the page console to relax the boundary after ASCII words too. Tests: `node test/detection.test.mjs`. MIT licensed.

## License

[MIT](LICENSE) © 2026 xubin0628
