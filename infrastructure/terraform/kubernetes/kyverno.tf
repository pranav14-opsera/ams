# Kubernetes admission control for image signature verification (WO-012).
# The ClusterPolicy itself (requiring cosign-verified images on every pod
# creation, across all namespaces) lives in
# infrastructure/kubernetes/admission/cosign-policy.yaml — applied via
# kubectl/GitOps once a cluster connector exists, not through this
# Terraform module (Kyverno policies are cluster config, not
# infrastructure provisioning, and change on a different cadence than the
# controller install).

resource "helm_release" "kyverno" {
  name             = "kyverno"
  repository       = "https://kyverno.github.io/kyverno"
  chart            = "kyverno"
  version          = "3.3.7"
  namespace        = "kyverno"
  create_namespace = true

  set {
    name  = "replicaCount"
    value = "3" # HA — the admission webhook sits in the pod-creation path for every namespace; a single replica is a cluster-wide SPOF
  }
  # Unsigned/tampered images must be rejected even if Kyverno itself is
  # temporarily unreachable — the acceptance criteria's whole point is
  # that a broken admission webhook must fail closed, not open.
  set {
    name  = "admissionController.failurePolicy"
    value = "Fail"
  }

  depends_on = [aws_eks_node_group.system]
}
