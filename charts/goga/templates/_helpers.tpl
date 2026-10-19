{{/*
Imagem do componente. Tag fixa em images.tags.<componente> (o deploy do GitHub
grava <componente>-<commit>) ganha; sem ela, <componente>-<images.version>.
*/}}
{{- define "goga.tag" -}}
{{- $root := index . 0 -}}{{- $name := index . 1 -}}
{{- $pinned := index (default dict $root.Values.images.tags) $name -}}
{{- if $pinned }}{{ $pinned }}{{ else }}{{ $name }}-{{ $root.Values.images.version }}{{ end -}}
{{- end -}}

{{- define "goga.image" -}}
{{- $root := index . 0 -}}
{{ $root.Values.images.repository }}:{{ include "goga.tag" . }}
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
Tag de versao (./push 1.0.0, sobrescrita a cada push): cada `helm upgrade` troca
esta anotacao e recria o pod; com pullPolicy Always ele baixa o digest atual.
Tag fixa por commit (deploy do GitHub): a propria troca de imagem faz o rollout,
e o componente que nao mudou mantem a tag e o pod nao reinicia.
*/}}
{{- define "goga.rollout" -}}
{{- $root := index . 0 -}}{{- $name := index . 1 -}}
{{- if index (default dict $root.Values.images.tags) $name -}}
goga/image: {{ include "goga.tag" . | quote }}
{{- else -}}
goga/rollout: {{ now | unixEpoch | quote }}
{{- end -}}
{{- end -}}

{{/* map → "k=v,k2=v2", para variavel de ambiente que o kb-api le como lista. */}}
{{- define "goga.kv" -}}
{{- $pares := list -}}
{{- range $k, $v := . }}{{- $pares = append $pares (printf "%s=%s" $k $v) -}}{{- end -}}
{{- join "," $pares -}}
{{- end -}}
