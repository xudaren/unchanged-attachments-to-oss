# OSS Credential Verification Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `max-keys=0` 导致的 `InvalidArgument`，并把凭证、权限、Bucket、CNAME 与网络异常提示为可操作的信息。

**Architecture:** 将 OSS XML/网络错误格式化提取为纯函数。`OssClient` 支持显式选择标准 Host 或 CNAME，按“标准 OSS Host → 可选 CNAME”执行两阶段验证；设置页展示安全的结构化错误。

**Tech Stack:** TypeScript、Obsidian `requestUrl`、Node.js built-in test runner、esbuild

---

### Task 1: 错误解析与测试基础

**Files:**
- Modify: `package.json`
- Create: `src/oss/errors.ts`
- Create: `tests/oss/errors.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖 OSS XML 的 `Code/Message/RequestId/ArgumentName/ArgumentValue`，以及 `ERR_CONNECTION_CLOSED`、DNS、超时和 TLS 错误；断言输出不泄露 Secret。

- [ ] **Step 2: 验证测试失败**

Run: `npm test`

Expected: FAIL，错误模块尚不存在。

- [ ] **Step 3: 实现最小错误 API**

```ts
export interface OssErrorDetails {
  status: number;
  code: string;
  message: string;
  requestId: string;
  argumentName: string;
  argumentValue: string;
}

export function parseOssErrorXml(status: number, body: string): OssErrorDetails;
export function formatCredentialError(error: unknown, host: string): string;
```

错误码映射为凭证、权限、Bucket、请求参数或网络提示，仅保留安全诊断字段。

- [ ] **Step 4: 配置并运行测试**

在 `package.json` 增加用 esbuild 编译测试并执行 `node --test` 的脚本。

Run: `npm test`

Expected: PASS。

### Task 2: 合法参数与两阶段校验

**Files:**
- Modify: `src/oss/client.ts`
- Create: `tests/oss/client.test.ts`

- [ ] **Step 1: 写失败测试**

注入请求函数并记录请求：无 CNAME 时请求标准 Host 且使用 `list-type=2&max-keys=1`；有 CNAME 时先请求标准 Host、再请求 CNAME；CNAME 失败标记标准凭证已通过。

- [ ] **Step 2: 验证测试失败**

Run: `npm test`

Expected: FAIL，现有实现发送 `max-keys=0` 且只请求优先 Host。

- [ ] **Step 3: 实现最小修复**

`OssClient` 构造函数接收默认值为 Obsidian `requestUrl` 的可注入请求函数；`doRequest` 接收可选 Host。业务请求保持 CNAME 优先，`verifyCredentials()` 先用标准 Host 和 `max-keys=1`，再校验可选 CNAME。

- [ ] **Step 4: 验证测试通过**

Run: `npm test`

Expected: PASS。

### Task 3: 设置页提示与完整回归

**Files:**
- Modify: `src/settings.ts`
- Modify: `README.md`

- [ ] **Step 1: 写失败测试**

增加阶段文案断言：标准 Host 失败显示“OSS 校验失败”；第二阶段失败显示“OSS 凭证有效，但 CNAME 校验失败”。

- [ ] **Step 2: 验证测试失败**

Run: `npm test`

Expected: FAIL，阶段提示尚未接入。

- [ ] **Step 3: 接入详细提示**

设置页使用安全格式化函数显示分类原因、目标 Host 和 RequestId；更新 README 校验说明。

- [ ] **Step 4: 完整验证**

Run: `npm test && npm run typecheck && npm run build`

Expected: 全部 exit 0，无测试或类型错误。

