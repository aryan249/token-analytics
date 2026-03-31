{{- define "token-analytics.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag }}
{{- end -}}

{{- define "token-analytics.labels" -}}
app.kubernetes.io/managed-by: helm
app.kubernetes.io/part-of: {{ .Chart.Name }}
{{- end -}}
