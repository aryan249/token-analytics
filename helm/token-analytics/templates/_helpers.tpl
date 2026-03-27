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
  runAsUser: 1001
  runAsGroup: 1001
  fsGroup: 1001
{{- end -}}

{{- define "token-analytics.containerSecurity" -}}
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: ["ALL"]
volumeMounts:
  - name: tmp
    mountPath: /tmp
{{- end -}}

{{- define "token-analytics.tmpVolume" -}}
volumes:
  - name: tmp
    emptyDir: {}
{{- end -}}

{{- define "token-analytics.antiAffinity" -}}
affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchLabels:
              app: {{ .app }}
          topologyKey: kubernetes.io/hostname
{{- end -}}
