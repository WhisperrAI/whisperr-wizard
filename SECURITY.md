# Security

The wizard reads repository code so it can install the Whisperr SDK, initialize it, and place `identify()` / `track()` calls. It applies a tool policy that blocks reads and searches of likely secret material, including `.env` and `.env.*` except `.env.example`, `.env.sample`, and `.env.template`; private key stores and key files such as `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `id_rsa*`, `id_ecdsa*`, and `id_ed25519*`; `*credentials*`, `*.tfvars`, `.netrc`, `.npmrc`, `.pypirc`, `.aws/**`, `.ssh/**`, `.gnupg/**`, and `secrets.*`.

Code context needed by the agent leaves the machine and is sent either to Whisperr's LLM gateway or directly to Anthropic, depending on your configuration. Run reports, including wired/skipped event outcomes and verification status, are sent to the Whisperr API.

The agent can run only a narrow Bash allowlist: package install/add operations for `npm`, `pnpm`, `yarn`, `bun`, `pip`, `pip3`, `poetry`, `uv`, `composer`, `pod`, `flutter pub`, `dart pub`, `gem`, `bundle`, and `go`; `mkdir`; and `git status`, `git diff`, or `git log`. Chained or substituted shell commands are denied unless each segment passes the allowlist.

The wizard requires a clean git working tree by default so its changes can be isolated and undone. The one-command revert shown by the wizard is `git restore . && git clean -fd`.

Report vulnerabilities to security@whisperr.net.
