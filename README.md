# Humr

```
 ╦ ╦╦ ╦╔╦╗╔═╗
 ╠═╣║ ║║║║╠╦╝
 ╩ ╩╚═╝╩ ╩╩╚═

 Run AI harnesses in production.
 Isolated. Credentialed. Scheduled.
```

Kubernetes platform for running AI agent harnesses (Claude Code, Codex, Gemini CLI) in isolated environments with credential injection, network isolation, and scheduled execution.

## Quick Start

```sh
mise install                # install deps, configure git hooks
mise run cluster:install    # create local k3s cluster + deploy (or upgrade) Humr
mise run cluster:status     # check pods
export KUBECONFIG="$(mise run cluster:kubeconfig)" # activate cluster env
```

Open **`humr.localhost:4444`** in your browser, create an instance from a template, and start chatting.

## Configuration

Agent harnesses and other connections require API tokens to communicate with their providers. These secrets are managed through the OneCLI dashboard at **`onecli.localhost:4444`**.

OneCLI acts as a proxy — agents never see the secrets directly. Instead, OneCLI intercepts outgoing requests from agent pods and injects the appropriate credentials before forwarding them to the provider.

1. **Add a secret** — open the OneCLI UI and create a new secret. For Anthropic, you can use `claude setup-token` as the token value. For other connections, use Apps or Generic secret.
2. **Allow the secret for an agent** — in the OneCLI UI, grant the secret to the specific agent that needs it. Only requests from allowed agents will have credentials injected.

## Slack Integration

Humr can connect agent instances to Slack — @mention the bot and the agent replies in-thread.

1. [Create a Slack app](https://api.slack.com/apps) with Socket Mode enabled and bot token scopes: `app_mentions:read`, `channels:history`, `chat:write`, `reactions:write`.
2. Generate an app-level token with the `connections:write` scope. Install (or upgrade) with it:

   ```sh
   mise run cluster:install -- --set=apiServer.slackAppToken=xapp-1-...
   ```

3. In the Humr UI, click the Slack icon on any instance and enter the **Bot Token** (`xoxb-...`) from your Slack app's OAuth page.

The app token is system-level (one per Humr deployment). The bot token is per-workspace and per-instance.

## Development

```sh
mise run check              # lint + type-check
mise run test               # run tests
mise run ui:run             # start UI dev server
```

Humr detects it is running in a sandbox by env `IS_SANDBOX` and skips provisioning the Lima VM, instead installing k3s directly to avoid nested virtualization.

## Architecture

See [docs/architecture.md](docs/architecture.md) for full details.

- **Controller** (Go) — K8s reconciler + cron scheduler
- **API Server** (TypeScript) — REST API + ACP WebSocket relay + serves UI
- **Agent Runtime** (TypeScript) — ACP server inside each agent pod
- **OneCLI** — credential injection proxy, network policy enforcement
- **Web UI** (React) — instance management, chat, scheduling
