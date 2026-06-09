# @whisperr/wizard

Integrate Whisperr into your app with one command.

```bash
npx @whisperr/wizard
```

Run it in your project's root. The wizard detects your framework, opens your
browser to sign in to Whisperr, and wires up the Whisperr SDK for you — then you
review the changes, commit, and deploy.

## What it does

- **Detects your stack** — Flutter, and more frameworks coming soon.
- **Authenticates** with your Whisperr account in the browser.
- **Sets up the SDK** — installs it, initializes it, identifies your users, and
  instruments the product events your Whisperr workspace is configured for.

## Requirements

- Node.js 18.17+
- A Whisperr account with onboarding completed

## Usage

```bash
# in your project root
npx @whisperr/wizard
```

Options:

```
--api <url>     Point at a specific Whisperr API (advanced)
-h, --help      Show help
-v, --version   Show version
```

---

Whisperr — predict churn, automate interventions, recover revenue.
[whisperr.net](https://whisperr.net)
