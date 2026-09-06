# Security Policy

`pi-dag-compact` is a Pi extension. Extensions run with the same privileges as
the Pi process and can execute arbitrary code. Only install this package from a
source you trust, and review the code before enabling it in a privileged
session.

## Supported versions

Security fixes are accepted against `main`. Pre-1.0 releases may include
breaking changes; please upgrade to the latest `main` or published tag before
reporting an issue that may already be fixed.

## Reporting a vulnerability

Do **not** open a public issue for security-sensitive reports.

Use GitHub Security Advisories for this repository:

https://github.com/moofone/pi-dag-compact/security/advisories/new

Include:

- A description of the issue and its impact
- Steps to reproduce, or relevant logs with secrets redacted
- Affected version, commit, or configuration
- Any known mitigations

## Scope

In scope:

- The published package, evaluation harness, and repository code
- Secret leakage from fixtures, logs, or eval reports
- Path traversal or unexpected writes outside an isolated eval workspace

Out of scope:

- Prompt injection against a coding agent
- Behavior of Pi itself, or of other extensions
- Local code execution that requires the user to install and run this package
- GPU, CUDA, or host compromise that requires running untrusted kernels
- Reports that depend on prior write access to the user's home directory or
  Pi configuration

## Eval harness

The M0 tests and `npm run eval:classic` default path must not call paid
providers or execute GPU workloads. If a change causes either, treat it as a
defect and do not publish that path as a default.
