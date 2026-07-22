# Security

The wizard sends repository code needed for model generation and SDK integration to OpenAI through Whisperr's authenticated gateway. A local development override can send it directly to OpenAI. Runtime receives generated entities, run progress, scrubbed terminal errors, and coverage results.

## Agent Boundaries

Sol and Terra receive host-owned function tools, not unrestricted local execution.

- Terra can only read, list, and search non-secret files inside the selected repository.
- Sol can use the same reads, exact file edits, new-file creation, ingestion environment configuration, allowlisted package operations, read-only Git commands, runtime mutations, progress, and completion.
- Neither agent receives a runtime bearer, OpenAI key, or ingestion key as a prompt or tool argument.
- Model tracing is disabled and sensitive trace payload collection is disabled.

Paths are checked lexically and resolved through filesystem symlinks before access. Reads, edits, and new-file parent paths must resolve inside the selected repository.

## Secret Isolation

Reads and searches block `.env` and `.env.*` except example/template files; private key stores; key and keystore suffixes; SSH key names; credentials files; `.netrc`; `.npmrc`; `.pypirc`; `.aws`; `.ssh`; `.gnupg`; and `secrets.*`.

The model may use `__WHISPERR_INGESTION_KEY__` only in example environment files. Source code reads the key from environment or the repository's existing local configuration mechanism. A dedicated host tool writes the real value only to local `.env` files without reading their contents back to the model. Repository tools substitute the non-secret ingestion base URL and redact the ingestion key from reads, searches, command output, errors, and summaries.

The OpenAI key is passed directly to `OpenAIProvider`. It is never included in runtime payloads or local resume state. Child command environments remove OpenAI and Anthropic credential variables.

## Command And Write Policy

Repository commands are parsed into executable arguments without a shell on Unix; Windows uses a fixed `cmd.exe` shim command assembled only from validated tokens. Package operations can install only the SDK packages named by the active playbooks, with lifecycle scripts disabled. Dependency manifests, package-manager executable configuration, and managed dependency directories can only be changed by those approved package operations. Git access is limited to metadata-only `status` and `diff` forms. Command chaining, substitution, expansion, redirection, arbitrary packages, external install targets, environment dumps, network clients, destructive commands, commits, pushes, and resets are denied.

Writes to `.git`, GitHub Actions, and common CI configuration paths are denied. The wizard does not commit or push.

## Git And Resume Safety

A new run requires a clean Git working tree unless `--force` is explicit. A matching incomplete run can continue with prior wizard edits present. Each invocation records the current changed-file contents, so a failed invocation can restore its own edits without discarding earlier wizard work or user changes present at invocation start.

Local resume files are outside the customer repository, mode 0600, and contain only run and conversation identifiers.

## Residual Risks

Allowed package managers still access package registries and modify dependency manifests and lockfiles. Install only in repositories where those package managers and the approved Whisperr SDK packages are trusted.

Deterministic verification invokes the static command defined by the selected playbook and can execute project tooling. Model and session credentials are removed from child environments, but local repository tooling remains a trust boundary.

Run the wizard only in repositories whose dependencies and package scripts you trust. Review the resulting diff before committing.

Report vulnerabilities to security@whisperr.net.
