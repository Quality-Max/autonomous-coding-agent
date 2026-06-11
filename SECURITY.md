# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report it privately through GitHub's
[private vulnerability reporting](https://github.com/Quality-Max/autonomous-coding-agent/security/advisories/new):

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, including steps to reproduce and the potential impact.

You can also reach the maintainers via the contact form at
[qualitymax.io](https://qualitymax.io).

We aim to acknowledge reports within a few business days and will keep you
updated as we investigate and ship a fix.

## Scope

This project runs untrusted, model-generated commands inside isolated cloud
sandboxes. When reviewing or reporting, the most security-sensitive areas are:

- **SSRF / URL validation** — the live-preview guard (`assertSafeHttpUrl` in
  `lib/preview.ts`), which gates user/agent-supplied preview URLs.
- **Command construction** — `shellQuote` and the agent tool definitions in
  `lib/tools.ts`.
- **Sandbox lifecycle** — session-scoped sandbox creation and teardown in
  `lib/sandbox.ts` and `lib/preview.ts`.
- **MCP connections** — server URL validation and token handling in `lib/mcp.ts`.

These paths have unit coverage; please include a failing test or a clear
reproduction with any report that touches them.

## Supported versions

This is an actively developed showcase project; security fixes are applied to
the `master` branch. There is no separate long-term support branch.
