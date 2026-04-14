# ADK-03: Go Controller Implementation Plan

**Goal:** Go K8s controller that watches ConfigMaps, reconciles StatefulSets/Services/NetworkPolicies, runs cron scheduler, provisions OneCLI agent tokens, delivers triggers via pod exec.

**PRD:** https://github.ibm.com/ai-platform-incubation/humr/issues/11

---

## File Structure

```
packages/controller/
  main.go                              # Entrypoint: leader election, informers, workqueue
  pkg/
    types/types.go + types_test.go     # TemplateSpec, InstanceSpec, ScheduleSpec, parse helpers
    config/config.go + config_test.go  # Env-based config (namespace, OneCLI, gateway, lease)
    reconciler/
      resources.go + resources_test.go # Pure builders: BuildStatefulSet, BuildService, BuildNetworkPolicy
      status.go + status_test.go       # Write status.yaml to ConfigMaps
      template.go + template_test.go   # Resolve template ConfigMap → TemplateSpec via informer lister
      instance.go + instance_test.go   # Orchestrator: parse spec → resolve template → build resources → apply → write status
    scheduler/
      scheduler.go + scheduler_test.go # Cron scheduler + exec-based trigger delivery
    onecli/
      client.go + client_test.go       # Client interface + HTTP impl + NoopClient
  Dockerfile
  deploy/helm/humr/templates/controller/deployment.yaml  # NEW
  deploy/helm/humr/values.yaml                           # ADD controller section
```

## Task Order (TDD — tests first in each)

1. **Types + YAML parsing** — `ParseTemplateSpec`, `ParseInstanceSpec`, `ParseScheduleSpec`, `SanitizeMountName`. Zero deps.
2. **Config** — `LoadFromEnv()` with defaults and required var validation.
3. **Resource builders** — Pure functions: `BuildStatefulSet`, `BuildService`, `BuildNetworkPolicy`. Table-driven tests comparing K8s object fields. This is the core — gets most test coverage.
4. **Status writer** — `WriteInstanceStatus`, `WriteScheduleStatus` patching ConfigMap `data["status.yaml"]` without touching `spec.yaml`. Tested with fake clientset.
5. **OneCLI client** — Interface for testability + HTTP impl. Tested with `httptest.NewServer`.
6. **Template resolver** — Reads template ConfigMap from informer lister, parses spec. Tested with fake clientset + informer.
7. **Instance reconciler** — Orchestrates: parse → resolve → build → apply (create-or-update) → OneCLI provision → write status. Tested with fake clientset + mock OneCLI. Covers: create, hibernate, wake, delete, error flows.
8. **Scheduler** — `robfig/cron` + exec-based trigger delivery (`/workspace/.triggers/{ts}.json`). Tested with fake clientset (verifies exec action recorded).
9. **Main entrypoint** — Leader election (Leases), SharedInformerFactory with label selector, workqueue, worker loop dispatching to reconciler/scheduler. Build-only verification.
10. **Dockerfile + Helm** — Multi-stage Go build. Deployment template with env vars from Helm values. Verify with `helm lint` + `helm template | kubeconform`.

## Key Design Decisions

- **Raw client-go** (not controller-runtime) — we watch ConfigMaps not CRDs, informers + workqueue is the right weight
- **Owner references** on StatefulSet/Service/NetworkPolicy → instance ConfigMap. K8s garbage collection handles cascade delete.
- **OneCLI client interface** — real HTTP impl in prod, mock in reconciler tests, `NoopClient` when OneCLI not configured
- **Resource builders are pure functions** — `(name, instanceSpec, templateSpec, config, ownerCM) → K8s object`. Most testable, most critical.
- **Fake clientset** for all K8s interaction tests. No envtest/real cluster needed for unit tests.

## Verification

- `go test ./... -v` — all pass
- `go vet ./...` — clean
- `go build -o dist/controller .` — compiles
- `mise run helm:check:lint` + `mise run helm:check:render` — pass
- Manual: `mise run cluster:install`, create template + instance ConfigMaps, verify StatefulSet appears
