package scheduler

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/robfig/cron/v3"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	restclient "k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
	"k8s.io/client-go/util/retry"
	"gopkg.in/yaml.v3"

	"github.com/kagenti/humr/packages/controller/pkg/config"
	"github.com/kagenti/humr/packages/controller/pkg/reconciler"
	"github.com/kagenti/humr/packages/controller/pkg/types"
)

const (
	wakePollInterval = 1 * time.Second
	wakeTimeout      = 2 * time.Minute
)

type Scheduler struct {
	client    kubernetes.Interface
	config    *config.Config
	cron      *cron.Cron
	schedules map[string]cron.EntryID
	restCfg   *restclient.Config // nil in tests
}

func New(client kubernetes.Interface, cfg *config.Config) *Scheduler {
	return &Scheduler{
		client:    client,
		config:    cfg,
		cron:      cron.New(),
		schedules: make(map[string]cron.EntryID),
	}
}

func (s *Scheduler) WithRESTConfig(cfg *restclient.Config) *Scheduler {
	s.restCfg = cfg
	return s
}

func (s *Scheduler) Start() { s.cron.Start() }
func (s *Scheduler) Stop()  { s.cron.Stop() }

func (s *Scheduler) SyncSchedule(cm *corev1.ConfigMap) error {
	name := cm.Name
	instanceName := cm.Labels["humr.ai/instance"]

	specYAML, ok := cm.Data["spec.yaml"]
	if !ok {
		return fmt.Errorf("schedule %s: no spec.yaml", name)
	}
	spec, err := types.ParseScheduleSpec(specYAML)
	if err != nil {
		return fmt.Errorf("schedule %s: %w", name, err)
	}

	// Remove existing entry if present
	if entryID, exists := s.schedules[name]; exists {
		s.cron.Remove(entryID)
		delete(s.schedules, name)
	}

	if !spec.Enabled {
		return nil
	}

	entryID, err := s.cron.AddFunc(spec.Cron, func() {
		ctx := context.Background()
		fireErr := s.fire(ctx, instanceName, name, spec)

		// Always write schedule status, even on failure
		now := time.Now().UTC().Format(time.RFC3339)
		nextRun := ""
		if eid, exists := s.schedules[name]; exists {
			entry := s.cron.Entry(eid)
			if !entry.Next.IsZero() {
				nextRun = entry.Next.UTC().Format(time.RFC3339)
			}
		}
		result := "success"
		if fireErr != nil {
			result = fireErr.Error()
			slog.Error("schedule fire failed", "schedule", name, "instance", instanceName, "error", fireErr)
		}
		if err := reconciler.WriteScheduleStatus(ctx, s.client, s.config.Namespace, name, types.NewScheduleStatus(now, nextRun, result)); err != nil {
			slog.Error("writing schedule status", "schedule", name, "error", err)
		}
	})
	if err != nil {
		return fmt.Errorf("schedule %s: invalid cron %q: %w", name, spec.Cron, err)
	}
	s.schedules[name] = entryID
	slog.Info("cron registered", "schedule", name, "cron", spec.Cron)
	return nil
}

func (s *Scheduler) RemoveSchedule(name string) {
	if entryID, exists := s.schedules[name]; exists {
		s.cron.Remove(entryID)
		delete(s.schedules, name)
	}
}

func (s *Scheduler) fire(ctx context.Context, instanceName, scheduleName string, spec *types.ScheduleSpec) error {
	// Wake instance if hibernated
	woke, err := s.wakeIfHibernated(ctx, instanceName)
	if err != nil {
		return fmt.Errorf("waking instance %s: %w", instanceName, err)
	}
	if woke {
		slog.Info("woke hibernated instance for schedule", "instance", instanceName, "schedule", scheduleName)
		if !s.waitForPodReady(ctx, instanceName) {
			return fmt.Errorf("instance %s did not become ready after wake", instanceName)
		}
	}

	// Build and deliver trigger
	trigger := map[string]any{
		"type":      spec.Type,
		"task":      spec.Task,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
		"schedule":  scheduleName,
	}
	if len(spec.MCPServers) > 0 {
		trigger["mcpServers"] = spec.MCPServers
	}
	if spec.SessionMode != "" {
		trigger["sessionMode"] = spec.SessionMode
	}
	triggerJSON, _ := json.Marshal(trigger)
	filename := fmt.Sprintf("/workspace/.triggers/%d.json", time.Now().UnixMilli())
	tmpFilename := filename + ".tmp"

	podName := instanceName + "-0"
	cmd := []string{"sh", "-c", fmt.Sprintf("mkdir -p /workspace/.triggers && cat > %s << 'TRIGGER_EOF'\n%s\nTRIGGER_EOF\nmv %s %s", tmpFilename, string(triggerJSON), tmpFilename, filename)}

	if s.restCfg != nil {
		req := s.client.CoreV1().RESTClient().Post().
			Resource("pods").
			Name(podName).
			Namespace(s.config.Namespace).
			SubResource("exec").
			VersionedParams(&corev1.PodExecOptions{
				Container: "agent",
				Command:   cmd,
				Stdout:    true,
				Stderr:    true,
			}, scheme.ParameterCodec)

		exec, err := remotecommand.NewSPDYExecutor(s.restCfg, "POST", req.URL())
		if err != nil {
			return fmt.Errorf("exec into %s: %w", podName, err)
		}
		if err := exec.StreamWithContext(ctx, remotecommand.StreamOptions{
			Stdout: io.Discard,
			Stderr: io.Discard,
		}); err != nil {
			return fmt.Errorf("exec stream to %s: %w", podName, err)
		}
	}
	slog.Info("trigger delivered", "pod", podName, "file", filename)
	return nil
}

// wakeIfHibernated checks if the instance is hibernated and wakes it.
// Returns true if the instance was hibernated and is now waking.
func (s *Scheduler) wakeIfHibernated(ctx context.Context, instanceName string) (bool, error) {
	var woke bool
	err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		cm, err := s.client.CoreV1().ConfigMaps(s.config.Namespace).Get(ctx, instanceName, metav1.GetOptions{})
		if err != nil {
			return err
		}
		instanceSpec, err := types.ParseInstanceSpec(cm.Data["spec.yaml"])
		if err != nil {
			return err
		}
		if instanceSpec.DesiredState != "hibernated" {
			woke = false
			return nil
		}
		instanceSpec.DesiredState = "running"
		specYAML, err := yaml.Marshal(instanceSpec)
		if err != nil {
			return err
		}
		cm.Data["spec.yaml"] = string(specYAML)
		if cm.Annotations == nil {
			cm.Annotations = make(map[string]string)
		}
		cm.Annotations["humr.ai/last-activity"] = time.Now().UTC().Format(time.RFC3339)
		_, err = s.client.CoreV1().ConfigMaps(s.config.Namespace).Update(ctx, cm, metav1.UpdateOptions{})
		if err == nil {
			woke = true
		}
		return err
	})
	return woke, err
}

// waitForPodReady polls until the instance pod is Ready or the timeout expires.
func (s *Scheduler) waitForPodReady(ctx context.Context, instanceName string) bool {
	podName := instanceName + "-0"
	deadline := time.Now().Add(wakeTimeout)
	for time.Now().Before(deadline) {
		pod, err := s.client.CoreV1().Pods(s.config.Namespace).Get(ctx, podName, metav1.GetOptions{})
		if err == nil {
			for _, c := range pod.Status.Conditions {
				if c.Type == corev1.PodReady && c.Status == corev1.ConditionTrue {
					return true
				}
			}
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(wakePollInterval):
		}
	}
	return false
}

