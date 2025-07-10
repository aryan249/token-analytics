{{- define "token-analytics.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag }}
{{- end -}}

{{- define "token-analytics.envFrom" -}}
- configMapRef:
    name: {{ .Chart.Name }}-config
- secretRef:
    name: {{ .Chart.Name }}-secrets
{{- end -}}

{{- define "token-analytics.labels" -}}
app.kubernetes.io/managed-by: helm
app.kubernetes.io/part-of: {{ .Chart.Name }}
{{- end -}}

{{- define "token-analytics.securityContext" -}}
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  fsGroup: 1000
{{- end -}}

{{- define "token-analytics.containerSecurity" -}}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: false
  capabilities:
    drop: ["ALL"]
{{- end -}}
