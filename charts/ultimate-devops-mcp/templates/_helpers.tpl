{{/*
Expand the name of the chart.
*/}}
{{- define "udm.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name.
*/}}
{{- define "udm.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "udm.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "udm.labels" -}}
helm.sh/chart: {{ include "udm.chart" . }}
{{ include "udm.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "udm.selectorLabels" -}}
app.kubernetes.io/name: {{ include "udm.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
ServiceAccount name
*/}}
{{- define "udm.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "udm.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
The Secret name env vars are sourced from — either the user-provided existing
Secret, or the one this chart creates.
*/}}
{{- define "udm.secretName" -}}
{{- if .Values.existingSecret }}
{{- .Values.existingSecret }}
{{- else }}
{{- include "udm.fullname" . }}
{{- end }}
{{- end }}

{{/*
Guard: an auth token must be provided somewhere, or the app refuses to boot.
We can't inspect an existingSecret's contents, so trust it when set.
*/}}
{{- define "udm.validateAuth" -}}
{{- if not .Values.insecureAllowNoAuth }}
{{- if not .Values.existingSecret }}
{{- if not (hasKey .Values.secrets "MCP_AUTH_TOKEN") }}
{{- fail "MCP_AUTH_TOKEN is required: set secrets.MCP_AUTH_TOKEN, or existingSecret (containing MCP_AUTH_TOKEN), or insecureAllowNoAuth=true to override (not recommended)." }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}
