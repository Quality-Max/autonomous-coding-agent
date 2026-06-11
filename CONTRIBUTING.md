# Contributing

Thanks for your interest in improving the Sandbox Coding Agent! Contributions of
all sizes are welcome — bug reports, docs, and pull requests.

## Getting set up

```bash
git clone https://github.com/Quality-Max/autonomous-coding-agent.git
cd autonomous-coding-agent
npm install
cp .env.example .env.local   # then fill in your keys
npm run dev
```

You'll need an [E2B API key](https://e2b.dev/docs/getting-started/api-key) and at
least one LLM provider key (Anthropic, OpenAI, or Google). See the
[README](README.md) for the full list of environment variables.

## Before you open a pull request

Run the checks locally — CI runs the same ones:

```bash
npm run lint    # ESLint
npm test        # Vitest (deterministic; needs no credentials)
npm run build   # production build
```

A typecheck (`npx tsc --noEmit`) should also pass clean.

The default test suite is deterministic and runs without any credentials. The
live end-to-end smoke test (`lib/preview.e2e.test.ts`) only runs when
`E2B_API_KEY` is set, so it's skipped in CI by default.

## Guidelines

- **Keep it focused.** One logical change per PR; smaller is easier to review.
- **Match the surrounding style.** TypeScript, the existing file conventions, and
  the tokenized CSS in `app/globals.css` (use the CSS variables, don't hardcode
  colors).
- **Add tests** for new behavior where it's practical, especially around the
  security validators in `lib/preview.ts` and tool definitions in `lib/tools.ts`.
- **Never commit secrets.** `.env.local` is gitignored; use `.env.example` to
  document any new environment variable you introduce.
- **Update the docs.** If you change setup, env vars, or behavior, update the
  README (and `.env.example`) in the same PR.

## Reporting bugs

Open an issue with steps to reproduce, what you expected, and what happened. For
security issues, please follow [SECURITY.md](SECURITY.md) instead of opening a
public issue.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
