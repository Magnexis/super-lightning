# Workload profiles

Workload profiles are starting points, not magic modes. They tune the HTTP acceleration layer; they do not claim to speed computation that happens inside a model server, GPU, compiler, or agent runtime.

## AI training

```json
{
  "workloadProfile": "ai-training",
  "routes": [
    {
      "prefix": "/datasets",
      "upstream": "https://datasets.example.com",
      "ignoreQueryParameters": ["utm_source"]
    }
  ]
}
```

Use it for public dataset shards, tokenizer files, model manifests, checkpoint metadata, and artifacts repeatedly fetched over HTTP. Keep signed download URLs, user credentials, dataset revisions, and access scopes out of query normalization.

## AI agents

```json
{
  "workloadProfile": "ai-agent",
  "routes": [
    { "prefix": "/docs", "upstream": "https://docs.example.com" },
    { "prefix": "/catalog", "upstream": "https://api.example.com" }
  ]
}
```

Use it in front of safe, repeated GET/HEAD calls made by tools. It reduces repeated upstream reads, handles brief outages with stale public data, and coalesces concurrent agent requests. It deliberately does not cache agent prompts, model-generation POSTs, authorization-bearing requests, or user-specific tool output.

## Developer work

Use `developer-work` for registries, package metadata, artifact indexes, and documentation mirrors. Cache warming can prime common public paths after a deployment.
