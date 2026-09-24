# GPTOpt

给 **手机远程控制电脑** 场景使用的 ChatGPT 油猴脚本。

当前功能：

- 把 ChatGPT 放进真正交换宽高后的同源 iframe，再整体旋转 90°。
- 避免直接旋转 ChatGPT DOM 时出现的 sticky / sidebar / vh / 遮罩 / 错位问题。
- 支持顺时针 / 逆时针切换。
- 自动同步 iframe 内当前会话 URL 到外层地址栏。
- 在横置 iframe 内集成 **Conversation Overview** 会话导航：
  - 每轮提问快捷跳转；
  - 回答标题分级导航；
  - 处理 ChatGPT 虚拟化；
  - 可替代时有时无的原生右侧会话导航。

## 安装

安装 Tampermonkey 后，打开：

`gptopt.user.js`

或者直接使用 Raw 地址安装：

`https://raw.githubusercontent.com/snownico0722/gptopt/main/gptopt.user.js`

保存后刷新 ChatGPT。

通过 Tampermonkey 菜单控制：

- 横置遥控模式开 / 关
- 顺时针 / 逆时针
- 重新计算横置尺寸

快捷键：

- `Alt + Shift + R`：开 / 关横置遥控模式

## 实现方式

外层浏览器例如是：

```text
2048 × 983
```

GPTOpt 创建一个真正的：

```text
983 × 2048
```

同源 ChatGPT iframe，让 ChatGPT 自己从一开始就按这个 viewport 布局，然后只旋转 iframe：

```text
983 × 2048
  ↓ 90°
2048 × 983
```

因此不需要再修改 ChatGPT 内部的 `main`、`thread`、侧栏、sticky 输入区或渐隐层。

## Conversation Overview 集成

导航功能来自：

- 上游：`boabab/conversation-overview`
- 版本：`1.5.0`
- 固定提交：`445a0e2d53fcfcf57b6297efc56346b2a773213a`

GPTOpt **没有把上游 12 万多字节源码直接复制进仓库**。

原因是截至集成时，上游仓库 GitHub 元数据为 `license: null`，仓库中也没有 LICENSE 文件。为了避免在没有明确许可证的情况下重新分发整份源码，GPTOpt 的做法是：

1. 只在 GPTOpt 创建的横置 iframe 内启动导航；
2. 从上游固定 commit 的 Raw 文件读取原版脚本；
3. 校验脚本名称、版本和 demo seam；
4. 第一次下载后缓存到 Tampermonkey 存储；
5. 使用上游已经公开提供的 `window.__COR_DEMO__` seam：
   - 允许它在 GPTOpt iframe 内运行；
   - 把 `minViewportWidth` 调整为 760；
   - 关闭 debug；
6. 不修改上游主体代码。

这意味着对用户来说仍然是 **只安装一个 GPTOpt 脚本**，同时保留上游代码的来源和版本边界。

如果上游以后补充明确的开源许可证，可以再考虑把固定版本直接 vendoring 进仓库，做成完全离线的单文件版本。

## 更新策略

横置逻辑由本仓库维护。

Conversation Overview 当前固定在指定 commit，不会因为上游突然更新而自动改变行为。需要升级导航版本时，应先验证 ChatGPT 当前 DOM 和 GPTOpt iframe 兼容性，再更新固定 commit。

## 已知限制

- 第一次启用会话导航时，需要访问一次 `raw.githubusercontent.com` 下载固定版本的上游脚本；之后使用 Tampermonkey 缓存。
- 如果网络环境阻止 Raw GitHub，第一次导航加载会失败，但横置功能仍可工作。
- ChatGPT 如果未来通过 `frame-ancestors 'none'` 等策略禁止同源 iframe，本方案需要调整。
