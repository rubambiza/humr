package reconciler

import (
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"

	"github.com/kagenti/humr/packages/controller/pkg/config"
	"github.com/kagenti/humr/packages/controller/pkg/types"
)

func BuildStatefulSet(name string, instance *types.InstanceSpec, agentSpec *types.AgentSpec, cfg *config.Config, agentName string, ownerCM *corev1.ConfigMap) *appsv1.StatefulSet {
	replicas := int32(1)
	if instance.DesiredState == "hibernated" {
		replicas = 0
	}

	labels := map[string]string{"humr.ai/instance": name}
	// Proxy URL uses $(ONECLI_ACCESS_TOKEN) interpolation — K8s resolves it from the Secret at pod start.
	// OneCLI expects the access token as the password (with "x" as dummy username).
	proxyAddr := fmt.Sprintf("http://x:$(ONECLI_ACCESS_TOKEN)@%s:%d", cfg.GatewayFQDN(), cfg.GatewayPort)
	caCertPath := "/etc/humr/ca/ca.crt"
	tokenSecretName := AgentTokenSecretName(agentName)

	// Merge env: platform + template + instance (last wins in K8s)
	// ONECLI_ACCESS_TOKEN must come before HTTPS_PROXY so $(ONECLI_ACCESS_TOKEN) resolves.
	env := []corev1.EnvVar{
		{Name: "ONECLI_ACCESS_TOKEN", ValueFrom: &corev1.EnvVarSource{
			SecretKeyRef: &corev1.SecretKeySelector{
				LocalObjectReference: corev1.LocalObjectReference{Name: tokenSecretName},
				Key:                  "access-token",
			},
		}},
		{Name: "HTTPS_PROXY", Value: proxyAddr},
		{Name: "HTTP_PROXY", Value: proxyAddr},
		{Name: "https_proxy", Value: proxyAddr},
		{Name: "http_proxy", Value: proxyAddr},
		{Name: "SSL_CERT_FILE", Value: caCertPath},
		{Name: "NODE_EXTRA_CA_CERTS", Value: caCertPath},
		{Name: "GIT_SSL_CAINFO", Value: caCertPath},
		{Name: "NODE_USE_ENV_PROXY", Value: "1"},
		{Name: "GIT_HTTP_PROXY_AUTHMETHOD", Value: "basic"},
		{Name: "GH_TOKEN", Value: "humr:sentinel"},
		{Name: "ADK_INSTANCE_ID", Value: name},
		{Name: "API_SERVER_URL", Value: cfg.APIServerURL()},
		{Name: "HOME", Value: "/home/agent"},
	}
	for _, e := range agentSpec.Env {
		env = append(env, corev1.EnvVar{Name: e.Name, Value: e.Value})
	}
	for _, e := range instance.Env {
		env = append(env, corev1.EnvVar{Name: e.Name, Value: e.Value})
	}

	// EnvFrom secretRef
	var envFrom []corev1.EnvFromSource
	if instance.SecretRef != "" {
		envFrom = append(envFrom, corev1.EnvFromSource{
			SecretRef: &corev1.SecretEnvSource{
				LocalObjectReference: corev1.LocalObjectReference{Name: instance.SecretRef},
			},
		})
	}

	// Volumes + mounts + PVC templates
	var volumes []corev1.Volume
	var volumeMounts []corev1.VolumeMount
	var pvcs []corev1.PersistentVolumeClaim

	for _, m := range agentSpec.Mounts {
		volName := types.SanitizeMountName(m.Path)
		volumeMounts = append(volumeMounts, corev1.VolumeMount{
			Name: volName, MountPath: m.Path,
		})
		if m.Persist {
			pvcs = append(pvcs, corev1.PersistentVolumeClaim{
				ObjectMeta: metav1.ObjectMeta{
					Name:   volName,
					Labels: labels,
				},
				Spec: corev1.PersistentVolumeClaimSpec{
					AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
					Resources: corev1.VolumeResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceStorage: resource.MustParse("10Gi"),
						},
					},
				},
			})
		} else {
			volumes = append(volumes, corev1.Volume{
				Name:         volName,
				VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}},
			})
		}
	}

	// CA cert volume (emptyDir, populated by init container via gateway TLS handshake)
	volumes = append(volumes, corev1.Volume{
		Name:         "ca-cert",
		VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}},
	})
	volumeMounts = append(volumeMounts, corev1.VolumeMount{
		Name: "ca-cert", MountPath: "/etc/humr/ca", ReadOnly: true,
	})

	// Resources
	resourceReqs := corev1.ResourceRequirements{}
	if agentSpec.Resources.Requests != nil {
		resourceReqs.Requests = toResourceList(agentSpec.Resources.Requests)
	}
	if agentSpec.Resources.Limits != nil {
		resourceReqs.Limits = toResourceList(agentSpec.Resources.Limits)
	}

	// Init containers: CA cert fetch (platform) + optional user init
	//
	// The CA init container fetches the MITM CA certificate from the OneCLI web
	// API (/api/container-config). Uses busybox (wget + awk) to avoid any
	// dependency on the agent image contents.
	caCertScript := fmt.Sprintf(
		`until wget -qO /etc/humr/ca/ca.crt "%s/api/gateway/ca" 2>/dev/null; do sleep 2; done`,
		cfg.WebURL())

	initContainers := []corev1.Container{{
		Name:            "fetch-ca-cert",
		Image:           cfg.CACertInitImage,
		ImagePullPolicy: corev1.PullIfNotPresent,
		Command:         []string{"sh", "-c", caCertScript},
		VolumeMounts: []corev1.VolumeMount{{
			Name: "ca-cert", MountPath: "/etc/humr/ca",
		}},
	}}
	if agentSpec.Init != "" {
		initContainers = append(initContainers, corev1.Container{
			Name:            "init",
			Image:           agentSpec.Image,
			ImagePullPolicy: corev1.PullPolicy(cfg.AgentImagePullPolicy),
			Command:         []string{"sh", "-c", agentSpec.Init},
			VolumeMounts:    volumeMounts,
		})
	}

	// Image pull secrets
	var pullSecrets []corev1.LocalObjectReference
	for _, name := range cfg.AgentImagePullSecrets {
		pullSecrets = append(pullSecrets, corev1.LocalObjectReference{Name: name})
	}

	// Pod security context
	var podSec *corev1.PodSecurityContext
	if agentSpec.SecurityContext != nil {
		podSec = &corev1.PodSecurityContext{
			RunAsNonRoot: agentSpec.SecurityContext.RunAsNonRoot,
		}
	}

	return &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: cfg.Namespace,
			Labels:    labels,
			OwnerReferences: []metav1.OwnerReference{
				*metav1.NewControllerRef(ownerCM, corev1.SchemeGroupVersion.WithKind("ConfigMap")),
			},
		},
		Spec: appsv1.StatefulSetSpec{
			Replicas:             &replicas,
			ServiceName:          name,
			Selector:             &metav1.LabelSelector{MatchLabels: labels},
			VolumeClaimTemplates: pvcs,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					TerminationGracePeriodSeconds: &cfg.TerminationGracePeriod,
					ImagePullSecrets:              pullSecrets,
					SecurityContext:               podSec,
					InitContainers:                initContainers,
					Containers: []corev1.Container{{
						Name:            "agent",
						Image:           agentSpec.Image,
						ImagePullPolicy: corev1.PullPolicy(cfg.AgentImagePullPolicy),
						Ports:           []corev1.ContainerPort{{
							Name: "acp", ContainerPort: 8080,
						}},
						Env:     env,
						EnvFrom: envFrom,
						ReadinessProbe: &corev1.Probe{
							ProbeHandler:  corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{Path: "/healthz", Port: intstr.FromString("acp")}},
							PeriodSeconds: 1,
						},
						LivenessProbe: &corev1.Probe{
							ProbeHandler:        corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{Path: "/healthz", Port: intstr.FromString("acp")}},
							InitialDelaySeconds: 10,
							PeriodSeconds:       10,
						},
						SecurityContext: &corev1.SecurityContext{
							Capabilities: &corev1.Capabilities{
								Drop: []corev1.Capability{"ALL"},
							},
						},
						Resources:    resourceReqs,
						VolumeMounts: volumeMounts,
					}},
					Volumes: volumes,
				},
			},
		},
	}
}

func BuildService(name string, cfg *config.Config, ownerCM *corev1.ConfigMap) *corev1.Service {
	return &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: cfg.Namespace,
			Labels:    map[string]string{"humr.ai/instance": name},
			OwnerReferences: []metav1.OwnerReference{
				*metav1.NewControllerRef(ownerCM, corev1.SchemeGroupVersion.WithKind("ConfigMap")),
			},
		},
		Spec: corev1.ServiceSpec{
			ClusterIP: corev1.ClusterIPNone,
			Selector:  map[string]string{"humr.ai/instance": name},
			Ports: []corev1.ServicePort{{
				Name: "acp", Port: 8080, TargetPort: intstr.FromString("acp"),
			}},
		},
	}
}

func BuildNetworkPolicy(name string, cfg *config.Config, ownerCM *corev1.ConfigMap) *networkingv1.NetworkPolicy {
	tcp := corev1.ProtocolTCP
	udp := corev1.ProtocolUDP
	acpPort := intstr.FromInt32(8080)
	gwPort := intstr.FromInt32(int32(cfg.GatewayPort))
	webPort := intstr.FromInt32(int32(cfg.WebPort))
	apiServerPort := intstr.FromInt32(4000)
	dnsPort := intstr.FromInt32(53)
	dnsTargetPort := intstr.FromInt32(5353)

	return &networkingv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name + "-egress",
			Namespace: cfg.Namespace,
			Labels:    map[string]string{"humr.ai/instance": name},
			OwnerReferences: []metav1.OwnerReference{
				*metav1.NewControllerRef(ownerCM, corev1.SchemeGroupVersion.WithKind("ConfigMap")),
			},
		},
		Spec: networkingv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{
				MatchLabels: map[string]string{"humr.ai/instance": name},
			},
			PolicyTypes: []networkingv1.PolicyType{
				networkingv1.PolicyTypeEgress,
				networkingv1.PolicyTypeIngress,
			},
			Egress: []networkingv1.NetworkPolicyEgressRule{
				{
					// OneCLI (cross-namespace: runs in the release namespace)
					// Gateway port for HTTPS proxy, web port for container-config (CA cert fetch)
					To: []networkingv1.NetworkPolicyPeer{{
						PodSelector: &metav1.LabelSelector{
							MatchLabels: map[string]string{"app.kubernetes.io/component": "onecli"},
						},
						NamespaceSelector: &metav1.LabelSelector{
							MatchLabels: map[string]string{"kubernetes.io/metadata.name": cfg.ReleaseNamespace},
						},
					}},
					Ports: []networkingv1.NetworkPolicyPort{
						{Protocol: &tcp, Port: &gwPort},
						{Protocol: &tcp, Port: &webPort},
					},
				},
				{
					// API Server (cross-namespace: runs in the release namespace)
					// Agent-runtime calls internal session endpoints for schedule session persistence
					To: []networkingv1.NetworkPolicyPeer{{
						PodSelector: &metav1.LabelSelector{
							MatchLabels: map[string]string{"app.kubernetes.io/component": "apiserver"},
						},
						NamespaceSelector: &metav1.LabelSelector{
							MatchLabels: map[string]string{"kubernetes.io/metadata.name": cfg.ReleaseNamespace},
						},
					}},
					Ports: []networkingv1.NetworkPolicyPort{
						{Protocol: &tcp, Port: &apiServerPort},
					},
				},
				{
					// DNS — allow both port 53 (service port) and 5353 (target port).
					// OVN-Kubernetes evaluates egress policy after DNAT, so the policy
					// sees the post-DNAT target port. OpenShift DNS pods run CoreDNS
					// on 5353 behind a Service that maps 53→5353.
					Ports: []networkingv1.NetworkPolicyPort{
						{Protocol: &tcp, Port: &dnsPort},
						{Protocol: &udp, Port: &dnsPort},
						{Protocol: &tcp, Port: &dnsTargetPort},
						{Protocol: &udp, Port: &dnsTargetPort},
					},
				},
			},
			Ingress: []networkingv1.NetworkPolicyIngressRule{{
				Ports: []networkingv1.NetworkPolicyPort{{
					Protocol: &tcp, Port: &acpPort,
				}},
			}},
		},
	}
}

func toResourceList(m map[string]string) corev1.ResourceList {
	rl := make(corev1.ResourceList)
	for k, v := range m {
		rl[corev1.ResourceName(k)] = resource.MustParse(v)
	}
	return rl
}
