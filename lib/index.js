/**
 * dsh-loop-breaker —— 硬止损：同一工具 + 同一参数反复出现就**中断本轮**；
 *                   以及**单轮预算**（步数 / 时长）超限即中断本轮。
 *
 * 为什么需要它：
 *   2026-09-13 从真实会话日志实测（session-7b9b38a1）：
 *     * 单个 turn 最多跑出 337 步；
 *     * 同一条命令被重复调用 120 次（`cat ~/.dsh/.credentials.yaml`）与 85 次；
 *     * dsh 自带的 `repeat-tool-reminder` **只提醒、不中断**（其配置面只有
 *       thresholds/include/exclude/argumentsPreviewChars，没有否决能力），
 *       也没有步数上限（`dsh-agent-loop` 只暴露 maxParallelToolCalls）。
 *   结果就是"跑四小时/最后只能 /stop"。
 *
 *   2026-09-16 又发现第二类失控（本文件下半部分新增的"预算"就是为它）：
 *     * 45 步 / 445 秒 / 零文字输出 —— 而且**每条命令都不一样**
 *       （模型在一路换着猜不存在的路径，例如 `/nas/dsh/@node-rs/zstd@*`）；
 *     * 这种"不同参数的空转"上面那条「同工具+同参数」判据**天然抓不到**；
 *     * AGENTS.md 里写的"单回合 25 步上限"只是软约束，弱模型会无视；
 *     * 后果不只是慢：被外部重启掐断后，会话状态留在"仍在跑"，
 *       导致该 DM 后续消息只进队列、**永远不起新一轮**（表现为 bot "收到消息不回复"）。
 *
 * 本插件补上那块缺失的硬止损，用两个上游扩展点：
 * *   * `tools/post-execute`（waterfall）—— 计数并在超限时 `{kind:'block'}` 否决该次结果，
 *     同时把说明作为 additionalContexts 注入（source=plugin，界面可见，不会被误判为用户消息）。
 *   * `agent/pre-step`（waterfall）—— 返回 `{kind:'reject'}`，让下一步不进入 → **本轮结束**。
 *
 * 判定是"同一工具 + 同一参数"（参数经规范化排序后比较），所以正常干活（每次不同命令）
 * 不会被误伤；只有真正的原地重复才会触发。**预算**那条按"每轮步数 / 每轮时长"计，
 * 与命令是否重复无关，用来兜住"换着花样空转"。
 *
 * @module dsh-loop-breaker
 */
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 加载心跳的落盘目录（可用环境变量覆盖，主要方便测试）。
 * ⚠️ 刻意放在 `~/.dsh/` **之外**：该目录被 dsh 的 chokidar 监视，
 *    在里面新增文件可能触发 EACCES/watch 事件（见 ~/.dsh/AGENTS.md 的写入卫生规则）。
 */
const HEARTBEAT_DIR = process.env.DSH_LOOP_BREAKER_LOG_DIR || '/home/dsh/.dsh-logs';

export const name = 'loop-breaker';

export const Config = z.object({
  /** 同一调用**连续**重复多少次即硬止损（默认 4）。 */
  consecutiveLimit: z.number().default(4),
  /** 同一调用在**单个 turn 内累计**多少次即硬止损（默认 12）。 */
  totalLimit: z.number().default(12),
  /** 参与计数的工具名通配（空 = 全部）。 */
  include: z.array(z.string()).default([]),
  /** 不参与计数的工具名通配。 */
  exclude: z.array(z.string()).default([]),
  /** 提示里引用的参数字符上限。 */
  argumentsPreviewChars: z.number().default(400),
  /** 单个 turn 的**步数上限**（默认 25）；0 = 关闭。 */
  maxStepsPerTurn: z.number().default(25),
  /** 单个 turn 的**时长上限（分钟）**（默认 5）；0 = 关闭。 */
  maxTurnMinutes: z.number().default(5),
});

/** 注入消息的来源标记：必须是 plugin，否则会被当成真实用户消息、触发重置。 */
const SOURCE = { kind: 'plugin', plugin: 'loop-breaker', form: 'notice' };

/** 把 `*` 通配转成正则。 */
function wildcardToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

/** 稳定序列化：对象键排序，保证同参数得到同一字符串。 */
function canonicalize(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  return '{' +
    Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') +
    '}';
}

/** 长参数截断，避免提示本身吃上下文。 */
function preview(text, max) {
  const s = String(text);
  return s.length <= max ? s : s.slice(0, max) + ` …（共 ${s.length} 字符）`;
}

/** 真实用户消息 = 新一轮开始（本插件注入的提示是 plugin，不会误判）。 */
function isNewTurn(messages) {
  return Array.isArray(messages) && messages.some((m) => m?.source?.kind === 'user');
}

/**
 * 安装止损监听。
 * @param ctx - 插件上下文；监听器随其销毁。
 * @param config - 经 Config 校验后的配置。
 */
export function apply(ctx, config) {
  const consecutiveLimit = Math.max(2, Number(config?.consecutiveLimit) || 4);
  const totalLimit = Math.max(consecutiveLimit, Number(config?.totalLimit) || 12);
  const previewChars = Math.max(40, Number(config?.argumentsPreviewChars) || 400);
  const include = (config?.include ?? []).map(wildcardToRegExp);
  const exclude = (config?.exclude ?? []).map(wildcardToRegExp);
  // 预算（0 或负数 = 该条关闭）
  const rawSteps = Number(config?.maxStepsPerTurn);
  const maxSteps = Number.isFinite(rawSteps) ? Math.floor(rawSteps) : 25;
  const rawMins = Number(config?.maxTurnMinutes);
  const maxMinutes = Number.isFinite(rawMins) ? rawMins : 5;

  // 加载心跳（2026-09-13 加）：往固定文件追加一行，用来证明插件确实被 import 并 apply 过。
  // 动机：dsh web 每次启动会还原 package.json，本插件曾长期"装了但没生效"却无人察觉；
  // 而 dump-config 只组合配置树、不 import 模块，配置里出现行 ≠ 插件真的加载了。
  // 本文件属主目录挂在 /nas（noatime），无法用 atime 判断，只能显式写标记。
  // 任何异常都必须吞掉——心跳绝不能影响插件主功能。
  try {
    mkdirSync(HEARTBEAT_DIR, { recursive: true });
    appendFileSync(
      join(HEARTBEAT_DIR, 'loop-breaker-loaded.log'),
      `${new Date().toISOString()} pid=${process.pid} consecutiveLimit=${consecutiveLimit} totalLimit=${totalLimit}` +
        ` maxStepsPerTurn=${maxSteps} maxTurnMinutes=${maxMinutes}\n`,
    );
  } catch {
    /* 心跳失败不影响止损功能 */
  }

  const chains = new WeakMap(); // agent -> { key, count }  连续链
  const totals = new WeakMap(); // agent -> Map<key, count> 本轮累计
  const armed = new WeakMap();  // agent -> string          待中断（原因）
  const budgets = new WeakMap();// agent -> { steps, startedAt } 本轮预算

  function tracked(toolName) {
    if (typeof toolName !== 'string' || toolName.length === 0) return false;
    if (include.length > 0 && !include.some((p) => p.test(toolName))) return false;
    return !exclude.some((p) => p.test(toolName));
  }

  function judge(exec) {
    if (!exec || !exec.agent) return undefined;
    if (!tracked(exec.name)) return undefined;

    const canonical = canonicalize(exec.arguments);
    const key = JSON.stringify([exec.name, canonical]);

    const chain = chains.get(exec.agent);
    const consecutive = chain && chain.key === key ? chain.count + 1 : 1;
    chains.set(exec.agent, { key, count: consecutive });

    let map = totals.get(exec.agent);
    if (!map) {
      map = new Map();
      totals.set(exec.agent, map);
    }
    const total = (map.get(key) ?? 0) + 1;
    map.set(key, total);

    const hitConsecutive = consecutive >= consecutiveLimit;
    const hitTotal = total >= totalLimit;
    if (!hitConsecutive && !hitTotal) return undefined;

    return {
      consecutive,
      total,
      hitConsecutive,
      args: preview(canonical, previewChars),
    };
  }

  /** 预算判定：推进本轮的步数与时长，超限则返回原因。 */
  function bumpBudget(agent) {
    if (!agent) return undefined;
    const now = Date.now();
    const state = budgets.get(agent) ?? { steps: 0, startedAt: now };
    state.steps += 1;
    budgets.set(agent, state);

    const minutes = (now - state.startedAt) / 60000;
    const overSteps = maxSteps > 0 && state.steps > maxSteps;
    const overTime = maxMinutes > 0 && minutes > maxMinutes;
    if (!overSteps && !overTime) return undefined;

    budgets.delete(agent);
    return {
      steps: state.steps,
      minutes: Number(minutes.toFixed(1)),
      overSteps,
      overTime,
      reason: overSteps
        ? `本轮已达步数上限（${state.steps} > ${maxSteps} 步）`
        : `本轮已达时长上限（${minutes.toFixed(1)} > ${maxMinutes} 分钟）`,
    };
  }

  /** 清空某个 agent 的全部计数（新一轮 / 结束本轮时调用）。 */
  function reset(agent) {
    chains.delete(agent);
    totals.delete(agent);
    armed.delete(agent);
    budgets.delete(agent);
  }

  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const verdict = judge(exec);
    const downstream = await next();
    if (!verdict) return downstream;

    const detail = verdict.hitConsecutive
      ? `同一调用**连续**重复 ${verdict.consecutive} 次`
      : `同一调用在本轮**累计** ${verdict.total} 次`;

    const text = [
      `⛔ 硬止损（dsh-loop-breaker）：${detail}，本轮已被强制中断。`,
      `- tool: ${exec.name}`,
      `- arguments: ${verdict.args}`,
      '',
      '重复同样的调用不会产生新信息。本轮已结束 —— 请换一种做法/换参数重新开始，',
      '或者直接向用户说明卡在哪一步、需要什么决策，不要继续重试同一调用。',
    ].join('\n');

    armed.set(exec.agent, `${exec.name} 连续 ${verdict.consecutive} / 本轮 ${verdict.total}`);
    ctx.logger?.warn?.(
      `loop-breaker: 硬止损触发 —— ${exec.name} 连续 ${verdict.consecutive} 次 / 本轮累计 ${verdict.total} 次；下一步将被拒绝以结束本轮`,
    );

    const notice = createUserMessage({ content: [{ type: 'text', text }], source: SOURCE });
    return { kind: 'block', feedback: [{ type: 'text', text }], additionalContexts: [notice] };
  });

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    // ① 真实用户消息 = 新一轮开始：清空所有计数与待中断标记，并重置预算。
    //    注意本插件注入的提示是 source.kind === 'plugin'，不会误触发这里的重置。
    if (isNewTurn(messages)) {
      reset(agent);
      budgets.set(agent, { steps: 0, startedAt: Date.now() });
      return next();
    }

    // ② 已武装：拒绝下一步以结束本轮（与"重复"硬止损共用这条出口）。
    if (armed.has(agent)) {
      const reason = armed.get(agent);
      reset(agent);
      ctx.logger?.warn?.(`loop-breaker: 拒绝下一步以结束本轮（${reason}）`);
      return { kind: 'reject' };
    }

    // ③ 预算判定（步数 / 时长）：超限则先给模型一次"收尾说话"的机会，下一步再拒绝。
    try {
      const over = bumpBudget(agent);
      if (over) {
        const text = [
          `⛔ 硬止损（dsh-loop-breaker·预算）：${over.reason}，本轮已接近强制结束。`,
          `- 已用步数：${over.steps}${maxSteps > 0 ? ` / 上限 ${maxSteps}` : ''}`,
          `- 已用时：${over.minutes} 分钟${maxMinutes > 0 ? ` / 上限 ${maxMinutes}` : ''}`,
          '',
          '**现在立刻停止调用工具**，用一段话向用户汇报：已完成什么、卡在哪一步、需要用户做什么决策。',
          '不要再试探新路径或新命令。',
        ].join('\n');
        armed.set(agent, over.reason);
        ctx.logger?.warn?.(`loop-breaker: ${over.reason}；已注入收尾提示，下一步将被拒绝`);
        const notice = createUserMessage({ content: [{ type: 'text', text }], source: SOURCE });
        const decision = await next();
        if (decision && typeof decision === 'object' && decision.kind === 'reject') return decision;
        return { ...(decision ?? {}), messages: [...(decision?.messages ?? []), notice] };
      }
    } catch (error) {
      // 预算判定出问题绝不能打断正常流程（fail-open）
      ctx.logger?.warn?.(`loop-breaker: 预算判定异常：${error?.message ?? error}`);
    }

    return next();
  });
}
