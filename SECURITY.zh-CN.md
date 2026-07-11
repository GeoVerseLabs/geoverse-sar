# 安全策略

[English](./SECURITY.md) | 简体中文

## 受支持版本

项目处于 1.0 之前阶段，仅最新的 minor 版本线接收安全修复。

| 版本            | 是否支持           |
| --------------- | ------------------ |
| 0.1.x（最新）   | :white_check_mark: |
| 更早 / 归档版本 | :x:                |

## 报告漏洞

**请勿通过公开的 GitHub issue 报告安全漏洞。**

首选渠道：使用 GitHub 的
[私密漏洞报告](https://github.com/GeoVerseLabs/geoverse-sar/security/advisories/new)
（仓库 **Security** 标签页下的 "Report a vulnerability"）。

也可以直接给维护者发邮件：<libra.liuyb@gmail.com>。

### 报告内容建议包含

1. 漏洞描述与受影响的包（`@geoverse-sar/*`）
2. 复现步骤（最好是针对 playground 的最小片段，或单测风格的复现）
3. 潜在影响——注意 SAR 内置 AI/agent 入口：能绕过权限白名单、审批门或
   guardrails 中间件的提示词注入路径均属于漏洞范围
4. 修复建议（如有）

### 响应时间

- **首次响应**：48 小时内
- **状态更新**：7 天内
- **修复时限**：按严重程度——严重 ≤ 7 天，高 ≤ 14 天，中 ≤ 30 天，
  低危随下一个常规版本发布

## 范围说明

- 内核的治理面（权限、审计、journal、guardrails、审批门）是安全边界——
  绕过即漏洞。
- `@geoverse-sar/server` 的 token 处理（`Bearer token → CallerInfo`）是安全
  边界——通过网络伪造调用者身份即漏洞。
- LLM 提供商密钥由宿主应用从环境变量/配置读取；密钥经日志、审计记录或
  journal 流泄露也在范围内。
