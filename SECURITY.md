# Security

The wizard reads repository code so it can install the Whisperr SDK, initialize it, and place `identify()` / `track()` calls. Code context needed by the agent leaves the machine and is sent either to Whisperr's LLM gateway or directly to Anthropic, depending on your configuration. Run reports, including wired/skipped event outcomes and verification status, are sent to the Whisperr API.

Tool enforcement runs in a Claude Agent SDK `PreToolUse` hook that fires before every tool call, including calls the SDK would otherwise auto-allow. The same policy also remains wired through `canUseTool` as a second layer for permission-prompt paths.

Reads and searches are limited to paths inside the target repository and block likely secret material, including `.env` and `.env.*` except `.env.example`, `.env.sample`, and `.env.template`; private key stores and key files such as `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `id_rsa*`, `id_ecdsa*`, and `id_ed25519*`; `*credentials*`, `*.tfvars`, `.netrc`, `.npmrc`, `.pypirc`, `.aws/**`, `.ssh/**`, `.gnupg/**`, and `secrets.*`.

The agent can run only a narrow Bash allowlist: package install/add operations for `npm`, `pnpm`, `yarn`, `bun`, `pip`, `pip3`, `poetry`, `uv`, `composer`, `pod`, `flutter pub`, `dart pub`, `gem`, `bundle`, and `go`; `mkdir`; and `git status`, `git diff`, or `git log`. Chained or substituted shell commands are denied unless each segment passes the allowlist. Commands such as `env`, `printenv`, `set`, `cat`, `head`, and `ls` are not on the allowlist.

Write and Edit are limited to paths inside the target repository. They also refuse git and CI configuration paths, including `.git/**`, `.github/workflows/**`, `.circleci/**`, `.buildkite/**`, `.gitlab-ci.yml`, `azure-pipelines.yml`, `bitbucket-pipelines.yml`, `.drone.yml`, and `Jenkinsfile`.

## Residual risks

The Claude Agent SDK `env` option is process-wide for the agent subprocess that also makes model calls. The model-auth token must therefore be present in that process environment. Bash environment-dump commands are blocked by the wizard policy, but allowed package-manager installs may run lifecycle scripts with that environment, which is an inherent risk of permitting installs.

Read path checks are string-based repository containment checks. A symlink inside the repository that resolves outside the repository is not resolved to its final target before the read policy decision.

The wizard requires a clean git working tree by default so its changes can be isolated and undone. The one-command revert shown by the wizard is `git restore . && git clean -fd`.

Report vulnerabilities to security@whisperr.net.
