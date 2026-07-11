# Security Policy

English | [简体中文](./SECURITY.zh-CN.md)

## Supported Versions

The project is pre-1.0; only the latest published minor line receives security
fixes.

| Version           | Supported          |
| ----------------- | ------------------ |
| 0.1.x (latest)    | :white_check_mark: |
| earlier / archive | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Preferred channel: use GitHub's
[private vulnerability reporting](https://github.com/GeoVerseLabs/geoverse-sar/security/advisories/new)
("Report a vulnerability" under the repository's **Security** tab).

Alternatively, email the maintainer at <libra.liuyb@gmail.com>.

### What to include

1. A description of the vulnerability and the affected package(s)
   (`@geoverse-sar/*`)
2. Steps to reproduce (a minimal snippet against the playground or a unit-test
   style repro is ideal)
3. Potential impact — note that SAR embeds an AI/agent entry: prompt-injection
   paths that bypass the permission whitelist, approval gate, or guardrails
   middleware are in scope
4. Suggested fixes, if any

### Response timeline

- **Initial response**: within 48 hours
- **Status update**: within 7 days
- **Fix timeline**: by severity — Critical ≤ 7 days, High ≤ 14 days,
  Medium ≤ 30 days, Low in the next regular release

## Scope notes

- The kernel's governance surfaces (permissions, audit, journal, guardrails,
  approval gate) are security boundaries — bypasses are vulnerabilities.
- `@geoverse-sar/server` token handling (`Bearer token → CallerInfo`) is a
  security boundary — caller forgery through the wire is a vulnerability.
- LLM provider keys are read from environment/config by the host application;
  key leakage through logs, audit entries, or journal streams is in scope.
