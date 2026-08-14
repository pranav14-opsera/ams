{{- define "base-service.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "base-service.labels" -}}
app.kubernetes.io/name: {{ include "base-service.name" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Shared pod template spec — used by both the plain Deployment
(templates/deployment.yaml) and the Argo Rollouts Rollout
(templates/rollout.yaml, rollout.enabled=true) so the two controllers
run byte-identical pods. Only ONE of those two resources ever renders
for a given release (mutually exclusive on rollout.enabled), so there's
no risk of them drifting out of sync at deploy time even though the spec
lives in one place.
*/}}
{{- define "base-service.podTemplateSpec" -}}
metadata:
  labels:
    {{- include "base-service.labels" . | nindent 4 }}
spec:
  serviceAccountName: {{ include "base-service.name" . }}
  automountServiceAccountToken: {{ .Values.serviceAccount.automountToken }}
  securityContext:
    runAsNonRoot: true
    runAsUser: 10000
    fsGroup: 10000
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: {{ include "base-service.name" . }}
      image: "{{ .Values.image.repository }}:{{ required "image.tag must be set to an explicit, immutable version — \"latest\" is not permitted" .Values.image.tag }}"
      imagePullPolicy: {{ .Values.image.pullPolicy }}
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop:
            - ALL
      ports:
        - name: http
          containerPort: {{ .Values.containerPort }}
      livenessProbe:
        httpGet:
          path: {{ .Values.healthCheck.livenessPath }}
          port: http
        initialDelaySeconds: {{ .Values.healthCheck.initialDelaySeconds }}
        periodSeconds: {{ .Values.healthCheck.periodSeconds }}
      readinessProbe:
        httpGet:
          path: {{ .Values.healthCheck.readinessPath }}
          port: http
        initialDelaySeconds: {{ .Values.healthCheck.initialDelaySeconds }}
        periodSeconds: {{ .Values.healthCheck.periodSeconds }}
      startupProbe:
        httpGet:
          path: {{ .Values.healthCheck.startupPath }}
          port: http
        periodSeconds: {{ .Values.healthCheck.periodSeconds }}
        failureThreshold: {{ .Values.healthCheck.startupFailureThreshold }}
      resources:
        {{- toYaml .Values.resources | nindent 8 }}
      volumeMounts:
        - name: tmp
          mountPath: /tmp
  volumes:
    - name: tmp
      emptyDir: {}
{{- end -}}
