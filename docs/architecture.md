# ADK Platform — Architecture Reference

## 1. Overview

ADK is a Kubernetes platform for running AI code harnesses (Claude Code, Codex, Gemini CLI) in isolated, production-grade environments. It solves the gap between running an agent locally and running it reliably at scale: credential injection without the agent ever seeing real tokens, strict network isolation, scheduled execution, session persistence across hibernation, and human-in-the-loop approval.

The platform is harness-agnostic, model-agnostic, and deployable to any namespace-scoped Kubernetes environment (no cluster-admin required).

---

## 2. Architecture Diagram

```
+----------------------------------------------------------+
|  Web UI (React + Vite SPA, served by API Server)         |
+----------------------------+-----------------------------+
                             |
+----------------------------v-----------------------------+
|  API Server (TypeScript / Node.js)                       |
|  - REST API for instance lifecycle                       |
|  - Connects to agent pods via ACP WebSocket (inbound)    |
|  - Relays ACP between UI and agent pods                  |
|  - Serves static React UI build                          |
|  - Reads/writes K8s resources (ConfigMaps, Secrets)      |
|  - No reconciliation, no scheduling                      |
+---+------------------------------------------+-----------+
    | K8s API (read/write ConfigMaps, Secrets)  | ACP WebSocket
    |                                           | (API Server → agent pod)
+---+------------------------------------------------------+
|  K8s Resources (shared state between components)         |
|                                                          |
|  ConfigMaps:  agent-template, agent-instance,            |
|               agent-schedule                             |
|  Secrets:     per-instance credentials                   |
|  StatefulSets, PVCs, headless Services, NetworkPolicies: |
|               created by Controller                      |
+---+------------------------------------------------------+
    | K8s API (watch + reconcile)
    |
+---v------------------------------------------------------+
|  Controller (Go, singleton with leader election)         |
|  - Watches ConfigMaps with humr.ai/type labels           |
|  - Reconciles: StatefulSet + PVC + Service + NetPolicy   |
|  - In-process scheduler (cron + heartbeat)               |
|  - OneCLI agent token provisioning                       |
|  - Delivers scheduled prompts via mounted ConfigMap      |
|  - No user-facing API, no ACP                            |
+----------------------------------------------------------+

+----------------------------------------------------------+
|  Agent Pod (inside StatefulSet, per instance)            |
|  +-----------------------------------------------------+ |
|  | Harness container  | ACP server (listens on port,   | |
|  | (Claude Code, etc) | accepts WS from API Server)    | |
|  +--------+-----------+--------------------------------+ |
|           | HTTPS_PROXY                                  |
+-----------v----------------------------------------------+
            |
+-----------v----------------------------------------------+
|  OneCLI Gateway                                          |
|  - Credential injection (MITM)                           |
|  - Host/path policy enforcement                          |
|  - Audit log                                             |
+----------------------------------------------------------+
```

---

## 3. Components

### Controller (Go)

Stateless reconciler and in-process scheduler. Watches ConfigMaps labeled `humr.ai/type` and reconciles the desired state into StatefulSets, headless Services, and NetworkPolicies. Runs with leader election so restarts don't disrupt active agent sessions. On cron fire, ensures the pod is running and delivers trigger files via `kubectl exec`. Provisions per-instance OneCLI agent tokens on instance creation.

Talks to: Kubernetes API (watch + write), OneCLI REST API.
Technology: Go, `client-go`.

### API Server (TypeScript)

User-facing backend. Provides REST CRUD for instances, templates, and schedules (translating operations into ConfigMap writes), and relays ACP over WebSocket between the UI and agent pods. It writes `spec.yaml` in ConfigMaps expressing desired state; the Controller reconciles actual state. No StatefulSets or PVCs are created directly. Serves the React UI as static files.

Talks to: Kubernetes API (ConfigMaps, Secrets, Pod readiness), agent pods (ACP WebSocket via stable DNS).
Technology: TypeScript/Node.js.

### Agent Runtime (TypeScript)

Runs inside each agent pod. Listens on port 8080 as an ACP WebSocket server, bridging the API Server's inbound connection to the harness process (Claude Code) over stdio. Exposes `/healthz` for readiness and liveness probes. Watches `/workspace/.triggers/` for JSON files written by the Controller on schedule fires, creating a new ACP session per trigger — the same code path as an interactive user session. Implemented in `packages/agent-runtime`.

Talks to: API Server (inbound ACP WebSocket), harness process (stdio).
Technology: TypeScript/Node.js, ACP SDK.

### Web UI (React)

Single-page application served by the API Server. Provides instance management (create from template, configure, wake, hibernate, delete), real-time chat via ACP relay (UI WebSocket → API Server → agent pod), session list/resume, workspace file browser, schedule CRUD, and inline human-in-the-loop approval when the agent hits a policy boundary.

Talks to: API Server (REST for lifecycle, WebSocket for ACP relay).
Technology: React 18, Vite.

### OneCLI Gateway (Rust, deployed as-is)

Open-source MITM HTTP/HTTPS proxy ([onecli.sh](https://onecli.sh)). Agent pods route all outbound traffic through it via `HTTPS_PROXY`. OneCLI terminates TLS using a Helm-generated CA cert, matches the request to stored credentials, injects the real token, and forwards to the upstream. The agent never sees the real credential — only a placeholder in its environment. Policy rules block or rate-limit by host/path/method, scoped per agent token. All requests are audit-logged.

Talks to: external internet (on behalf of agents), Controller (via REST API for agent token management).
Technology: Rust (existing binary, deployed unchanged).

### OneCLI Web (Next.js, deployed as-is)

Dashboard UI bundled with OneCLI for managing agents, secrets, connections, and policy rules. Deployed as a separate Deployment + Service alongside the gateway. Used for credential management and audit log viewing; not extended by ADK.

Technology: Next.js (existing binary, deployed unchanged).

---

## 4. K8s Resource Model

### Why ConfigMaps, not CRDs

CRDs require cluster-admin to install — a hard blocker in OpenShift and other namespace-scoped environments. ConfigMaps with labels are deployable with standard namespace RBAC. The ConfigMap schema maps directly to a CRD spec if the project moves to a cluster with cluster-admin; the Controller's reconcile logic barely changes.

Discovery: `kubectl get cm -l humr.ai/type=agent-instance`

### Resource Types

**`agent-template`** — OCI image + configuration blueprint. Defines harness image, mount paths, init script, env vars, and resource limits. Managed by operators via Helm or `kubectl`.

**`agent-instance`** — A running or hibernated copy of a template. References a template and a Secret. The API Server writes `spec.yaml` (desired state); the Controller writes `status.yaml` (observed state). The API Server writes lightweight metadata (last activity, active session flag) as annotations on the ConfigMap's `metadata`, not in `data`, to avoid key contention.

**`agent-schedule`** — A cron or heartbeat schedule tied to an instance. The API Server writes `spec.yaml` (cron expression, prompt, enabled flag); the Controller writes `status.yaml` (`lastRun`, `nextRun`, `lastResult`). On restart, the Controller recomputes timers from `status.yaml`.

### spec.yaml / status.yaml split

Each ConfigMap uses separate data keys with a single writer per key:

- `spec.yaml` — written by the API Server (user intent)
- `status.yaml` — written by the Controller (infrastructure/scheduler state)

This mirrors the CRD `spec`/`status` subresource pattern and eliminates write contention between the two components.

### Reconciled resources per instance

```
ConfigMap (instance) + ConfigMap (template) + Secret
  → StatefulSet: {instance}      (replicas: 0=hibernated, 1=running)
  → headless Service: {instance} (stable DNS: {instance}-0.{instance}.{ns}.svc)
  → NetworkPolicy: {instance}-egress
```

PVCs are created automatically by StatefulSet `volumeClaimTemplates` and survive scale-to-zero. Deleting an instance ConfigMap cleans up the StatefulSet, Service, and NetworkPolicy — but not PVCs, which require explicit deletion.

---

## 5. Key Flows

### Create instance

```
UI → POST /api/v1/instances {template, name, secrets}
API Server: creates instance ConfigMap (spec.yaml: desiredState: running) + Secret
Controller: detects ConfigMap → reconciles StatefulSet + Service + NetworkPolicy
            → provisions OneCLI agent token → writes status.yaml: running
Pod starts, init runs, readiness probe passes (ACP port responding)
API Server: watches Pod readiness, notifies UI via WebSocket
UI: instance ready → user opens chat
```

### Chat with agent

```
UI opens WebSocket to API Server /api/v1/instances/:id/acp
API Server connects to {instance}-0.{instance}.{ns}.svc:8080 (ACP WebSocket)
API Server relays ACP messages bidirectionally: UI WS ↔ agent pod WS
API Server updates humr.ai/last-activity annotation on each relay
User closes chat → API Server disconnects from agent pod
```

### Scheduled execution

```
Controller cron fires for an instance
  If hibernated: patches spec.yaml desiredState: running, waits for pod readiness
  Execs into pod: writes /workspace/.triggers/{timestamp}.json with prompt payload
  Updates schedule status.yaml: lastRun, nextRun
Harness (inside pod): detects new trigger file
  Creates new ACP session with trigger prompt (same path as interactive session)
  Deletes trigger file after pickup
Controller: reads humr.ai/last-activity, hibernates after inactivity TTL
```

### Hibernate / Wake

```
Hibernate (auto):
  Controller detects humr.ai/last-activity older than TTL
  Patches instance spec.yaml: desiredState: hibernated
  Reconciles: StatefulSet replicas: 0, PVCs persist

Wake (manual):
  UI → POST /api/v1/instances/:id/wake
  API Server patches instance spec.yaml: desiredState: running
  Controller reconciles: StatefulSet replicas: 1
  Pod starts, PVCs mount, readiness probe passes
  API Server notifies UI: instance ready
  User resumes → ACP listSessions shows previous sessions from PVC
```

---

## 6. Security Model

| Layer | Mechanism | Enforces | Bypassable? |
|-------|-----------|----------|-------------|
| Network | K8s NetworkPolicy | Pod can only reach OneCLI gateway and DNS | No — kernel-level, enforced by CNI |
| Transport | OneCLI MITM proxy | All HTTPS traffic inspected, credentials injected | No — only route to the internet |
| Application | OneCLI policy rules | Block/rate-limit/approve by host + path + method | No — gateway-enforced |
| Behavioral | Agent rules (CLAUDE.md) | Agent asks before destructive actions | Yes — defense in depth only |

**What the agent cannot do:**
- See real credentials — OneCLI injects tokens at request time; agent has placeholders only
- Reach the internet directly — NetworkPolicy drops all egress except gateway and DNS
- Access other instances' data — each instance has its own PVC, agent token, and NetworkPolicy

**Explicitly deferred for v1:**
- DNS exfiltration (requires a DNS proxy)
- Kernel-level sandbox (gVisor/Kata)
- Per-instance network namespaces (currently share node-level network)

---

## 7. Deployment

Full cluster lifecycle via mise:

```sh
mise run cluster:install    # create humr-k3s VM (lima), install cert-manager + ADK chart (or upgrade if already installed)
mise run cluster:status     # show pods and cluster state
mise run cluster:logs       # show OneCLI pod logs
mise run cluster:uninstall  # helm uninstall (keeps PVCs)
mise run cluster:delete     # destroy the k3s VM entirely
```

Or manually:

```sh
helm install humr deploy/helm/humr
```

This deploys: OneCLI (gateway + web + PostgreSQL in one container), cert-manager CA, `humr-agents` namespace, RBAC, and a default agent template.

**Prerequisites:** cert-manager must be installed in the cluster before the ADK chart. `mise run cluster:install` handles this automatically.

### Helm template layout

```
deploy/helm/humr/templates/
  onecli/
    app.yaml              — OneCLI Deployment (gateway + web) + two Services
    postgres.yaml         — PostgreSQL StatefulSet + PVC + Service
    ca-secret.yaml        — cert-manager Issuer + Certificate (ECDSA PKCS8 CA)
    secrets.yaml          — auto-generated passwords and encryption keys
  controller/
    rbac.yaml             — ServiceAccount, ClusterRole, ClusterRoleBinding
  apiserver/
    rbac.yaml             — ServiceAccount, Roles, RoleBindings
  namespace.yaml          — humr-agents namespace
  default-template.yaml   — default Claude Code agent template ConfigMap
  NOTES.txt               — post-install instructions
  _helpers.tpl            — shared template helpers
```

Controller and API Server Deployments are added in subsequent plan phases.

### CA cert flow

OneCLI gateway auto-generates a self-signed MITM CA on first start, stored in its PVC at `/app/data/`. Agent pods fetch the CA certificate at startup via an init container that calls the OneCLI `/api/container-config` endpoint through the gateway proxy. The cert is written to a shared `emptyDir` volume at `/etc/humr/ca/ca.crt` and referenced by `SSL_CERT_FILE` and `NODE_EXTRA_CA_CERTS`.

### OneCLI architecture

OneCLI ships as a single Docker image (`ghcr.io/onecli/onecli:latest`) that runs both the Rust gateway and Node.js web app via `entrypoint.sh`. The chart deploys one Deployment with two Services (gateway:10255, web:10254) pointing at different ports on the same pod. PostgreSQL is a separate StatefulSet.

---

## 8. Repository Structure

```
packages/
  controller/          # Go — K8s reconciler + in-process scheduler (standalone Go module)
  api-server/          # TypeScript — REST + ACP WebSocket relay + static UI serving
  agent-runtime/       # TypeScript — ACP WebSocket server inside agent pod
  ui/                  # React + Vite — instance management, chat, file browser
deploy/
  helm/adk/            # Helm chart — all components + OneCLI + PostgreSQL
docs/
  specs/               # Design documents
  plans/               # Implementation plans (temporary, removed after execution)
  architecture.md      # This file
context/
  onecli/              # OneCLI reference source (read-only)
```

The Go controller is a standalone module (`packages/controller/go.mod`). TypeScript packages share a pnpm workspace (`pnpm-workspace.yaml`). Current packages include `agent-runtime` (ACP server inside agent pods) and `ui`.

---

## 9. Development

### Task runner

[mise](https://mise.jdx.dev/) is the task runner. Tasks are defined in `tasks.toml` (root aggregators) and per-package `tasks.toml` files, wired together via `mise.toml`.

```sh
mise run setup          # install deps, configure git hooks
mise run check          # lint + type-check all packages
mise run fix            # auto-fix linting issues
mise run test           # run all tests
mise run helm:check:lint  # helm lint + kubeconform validation
```

### Git hooks

Installed by `mise run setup`. Implemented as mise tasks:

- `git-hooks:pre-commit` — runs `check` (lint + type-check)
- `git-hooks:commit-msg` — deduplicates `Assisted-By:` trailers

### Per-package tasks

Each package (`packages/ui/tasks.toml`, `packages/controller/tasks.toml`, `deploy/helm/tasks.toml`) defines `setup`, `check`, `fix`, and `test` tasks namespaced to the package. The root `tasks.toml` aggregates them via `depends = ["*:check"]`.

### Cluster lifecycle

Defined in `deploy/tasks.toml`:

```sh
mise run cluster:install    # create humr-k3s VM (lima), install cert-manager + ADK chart (or upgrade)
mise run cluster:status     # show pods and cluster state
mise run cluster:logs       # show OneCLI pod logs
mise run cluster:uninstall  # helm uninstall (keeps PVCs)
mise run cluster:delete     # destroy k3s VM
```

### Tool versions

Managed by mise: Node.js 22, pnpm 10, Go 1.24, Helm (latest), kubeconform (latest), lima 2 (k3s VM).
