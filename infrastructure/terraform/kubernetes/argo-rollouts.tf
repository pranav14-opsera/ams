# Blue-green/canary deployment engine (WO-010). Argo Rollouts replaces the
# plain Deployment controller for any service that opts into
# `rollout.enabled=true` in the base-service Helm chart — see
# infrastructure/helm/base-service/templates/rollout.yaml. kube-prometheus-stack
# is the metrics source Argo Rollouts' AnalysisTemplates query for the
# error-rate/P95-latency canary gates.

resource "helm_release" "argo_rollouts" {
  name             = "argo-rollouts"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-rollouts"
  version          = "2.37.7"
  namespace        = "argo-rollouts"
  create_namespace = true

  # Controller-only: this platform doesn't use the Argo Rollouts dashboard UI
  # (kubectl-argo-rollouts CLI / Forge pipeline scripts drive promotion and
  # rollback instead), so the dashboard deployment is skipped.
  set {
    name  = "dashboard.enabled"
    value = "false"
  }
  set {
    name  = "controller.replicas"
    value = "2" # HA — a single controller replica is a deploy-pipeline SPOF
  }
  set {
    name  = "controller.metrics.enabled"
    value = "true" # scraped by kube-prometheus-stack below
  }

  depends_on = [aws_eks_node_group.system]
}

resource "helm_release" "kube_prometheus_stack" {
  name             = "kube-prometheus-stack"
  repository       = "https://prometheus-community.github.io/helm-charts"
  chart            = "kube-prometheus-stack"
  version          = "67.9.0"
  namespace        = "observability"
  create_namespace = true

  # AMS already has its own CloudWatch-based alerting (see
  # infrastructure/terraform/cache/redis, database/postgresql); this stack's
  # Alertmanager is unused — Argo Rollouts' AnalysisTemplates query
  # Prometheus directly, they don't need Alertmanager routing.
  set {
    name  = "alertmanager.enabled"
    value = "false"
  }
  set {
    name  = "prometheus.prometheusSpec.retention"
    value = "15d"
  }
  set {
    name  = "prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues"
    value = "false" # discover ServiceMonitors across all namespaces, not just this release's own
  }

  depends_on = [aws_eks_node_group.system]
}
