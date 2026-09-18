# dsh-loop-breaker

硬止损插件：**同一工具 + 同一参数反复调用时，直接中断本轮**。

## 为什么需要

2026-09-13 从真实会话日志实测：

- 单个 turn 最多跑出 **337 步**
- 同一条命令被重复调用 **120 次** / **85 次**
- dsh 自带的 `repeat-tool-reminder` **只提醒、不中断**
- `dsh-agent-loop` 只暴露 `maxParallelToolCalls`，**没有步数上限**

结果就是"跑四小时 / 最后只能 /stop"。

## 实现

用两个上游扩展点：

| 钩子 | 作用 |
|---|---|
| `tools/post-execute`（waterfall） | 计数；超限时返回 `{kind:'block', feedback, additionalContexts}` 否决该次结果并注入可见说明 |
| `agent/pre-step`（waterfall） | 返回 `{kind:'reject'}` 让下一步不进入 → **本轮结束** |

判定键是「工具名 + 参数规范化后的 JSON」，所以正常干活（每次不同命令）不会误伤。

## 配置

```yaml
- id: loop-breaker
  name: 'dsh-loop-breaker'
  config:
    consecutiveLimit: 4      # 连续重复多少次硬止损
    totalLimit: 12           # 单轮内累计多少次硬止损
    include: []              # 只统计这些工具（空=全部）
    exclude: []              # 排除这些工具
    argumentsPreviewChars: 400
```

## 安装

```bash
bash /nas/dsh/工具/dsh-loop-breaker/install.sh
```

装完**需要重启一次 dsh web** 才会加载（会短暂断开网页，会话不丢）：

```bash
dsh-restart
```

## 卸载

```bash
dsh plugin --profile web remove dsh-loop-breaker
rm -rf ~/.dsh/profiles/web/node_modules/dsh-loop-breaker
```
