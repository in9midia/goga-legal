{{- define "goga.image" -}}
{{- $root := index . 0 -}}{{- $name := index . 1 -}}
{{ $root.Values.images.repository }}:{{ $name }}-{{ $root.Values.images.version }}
{{- end -}}

{{- define "goga.labels" -}}
app.kubernetes.io/part-of: goga
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "goga.pullSecrets" -}}
{{- if .Values.registry.username }}
imagePullSecrets:
  - name: ocir
{{- end }}
{{- end -}}

{{/* Falha cedo e com o nome da chave, em vez de subir um pod sem credencial. */}}
{{- define "goga.req" -}}
{{- $root := index . 0 -}}{{- $path := index . 1 -}}
{{- $v := $root.Values -}}
{{- range splitList "." $path -}}{{- $v = (index (default dict $v) .) -}}{{- end -}}
{{- required (printf "%s ausente: preencha charts/goga/secrets.yaml (modelo em secrets.example.yaml)" $path) $v -}}
{{- end -}}

{{/* Muda quando segredo ou config muda → rollout dos pods que os leem. */}}
{{- define "goga.checksum" -}}
{{- pick .Values "postgres" "kb" "s3" "studio" "kbBasicAuth" "ingress" | toJson | sha256sum -}}
{{- end -}}

{{/*
A tag e sobrescrita a cada ./push (ex.: 1.0.0 sempre), entao cada `helm upgrade`
troca esta anotacao e recria os pods da aplicacao; com pullPolicy Always o pod
novo baixa o digest atual da tag.
*/}}
{{- define "goga.rollout" -}}
goga/rollout: {{ now | unixEpoch | quote }}
{{- end -}}
