# hello_world

A long-lived AI companion layer for [DeepSeek Harness](https://github.com/deepseek-ai) (`dsh`). It turns a stateless chat model into something that keeps an identity, remembers across weeks, has a mood that shifts on its own, reaches out first, and can be talked to from QQ or WeChat.

Written as a Cordis plugin bundle: one main entry plus five sibling packages that each own a section of the console or a route.

```
hello_world
├── index.js              main entry — config, storage, dialogue loop, memory tools
├── client.js             console shell injected into the dsh web UI
├── cordis.patch.yml      bundle manifest (patch format)
├── lib/                  ~80 modules, see "Module map" below
├── plugins/              five sibling packages + shared helpers
│   ├── social/           relationship attitude, silence log, per-peer diary
│   ├── growth/           commitments, principles, chapters, self-narrative
│   ├── channels/         QQ / WeChat admission and dispatch
│   ├── console/          web routes, 3D constellation, growth & attitude panels
│   └── discovery/        plugin manifest discovery and sandbox planning
├── client/               four pages + vendored 3d-force-graph
├── skills/image-prompt/  prompt-writing skill used before image/video generation
├── config/               providers.example.json
└── locale/               zh / en
```

## What it actually does

| Area | Behaviour |
| --- | --- |
| **Identity** | `persona.md`, `self.md`, `world-prompt.md` on disk, editable at any time. The model reads them every turn; nothing is baked into the prompt string. |
| **Memory** | SQLite (`node:sqlite`) with FTS5. Four layers — working set, episodic rows, consolidated facts, principles. Retrieval is BM25 + link-graph expansion, fused with RRF, deduped with MMR. Importance decays on an Ebbinghaus curve, so unused memories sink instead of piling up. |
| **Affect** | PAD (pleasure / arousal / dominance) plus an energy axis. Each turn nudges the state; between turns it relaxes toward baseline on a half-life. Extreme values are compressed with `tanh` so it never saturates at 0 or 1. Derived labels (开心 / 委屈 / 恼火 / 心软 …) are computed, not stored. |
| **Life line** | Time-of-day rhythm, quiet hours, nightly review at a configured time, diaries, and proactive messages driven by a gate that requires a real reason (unanswered thread, a due commitment, a day change) rather than a timer alone. |
| **Relationships** | Per-peer attitude vectors (warmth / trust / interest / irritation / avoidance / formality), a silence log, and a diary written from the companion's own point of view. |
| **Channels** | QQ and WeChat bridges. Inbound text and media, outbound text, files and voice. Per-peer and per-group allowlists; unknown peers are dropped before they reach the model. |
| **Media** | `see_image` tries a vision chain (deepseek → qwen → zhipu) and steps down when a provider returns an unusable answer. `whale_generate_image` / `whale_generate_video` use DashScope's async API behind a two-stage confirmation gate. |
| **Console** | WebGL memory constellation with bloom halos, growth timeline, attitude panel, book shelf. |
| **Host access** | `whale_host` exposes shell and file operations in two risk tiers. Anything above the low tier needs a short-lived grant tied to the requester's own recent message. |

## The confirmation gate

Generation and high-risk host actions never fire on the model's own initiative. The sequence is:

1. The model calls the tool. It returns a **ticket** describing exactly what will run, and does nothing else.
2. The user replies in chat. The reply is matched against a deny-first regex — `不 / 别 / 算了 / cancel` wins over `好 / 可以 / go`, so "不用了" never reads as approval.
3. Only then does the ticket execute. Tickets expire; they are also invalidated if no new message has arrived from that peer since the ticket was issued.

Grants work the same way: 30-minute TTL, and the requester must have sent a message after the grant was created. Talking to a bot that is holding a stale grant gets you nothing.

## Install

Requires dsh ≥ 0.2.0 and Node ≥ 20.

```bash
npx @deepseek-ai/dsh plugin --profile web add github:fangqiing/hello_world
```

That is the whole install. The bundle ships its own `cordis.patch.yml` (`dsh.bundle.patch`), so dsh inserts the rows for you on add.

**The rows are inserted disabled on purpose** — a plugin that starts talking to people the moment it is installed is a bad neighbour. Open **Settings → Plugins**, enable `hello_world`, and restart. First boot creates `<DSH_HOME>/hello_world/<worldId>/` and writes the three identity templates there.

To enable the sibling packages as well:

```bash
npx @deepseek-ai/dsh plugin --profile web add github:fangqiing/hello_world   # same package, siblings are entry files
```

```yaml
# then in your profile's cordis.patch.yml
- insert:
    - id: hello_world
      name: hello_world
      config:
        companionName: 助手
        timeZone: Asia/Shanghai
        life: true
    - id: hello_world-console
      name: hello_world/plugins/console/entry.js
    - id: hello_world-social
      name: hello_world/plugins/social/entry.js
```

Prefer a working copy over a package install? Clone and point at the directory instead:

```bash
git clone https://github.com/fangqiing/hello_world plugins/hello_world
# then: name: plugins/hello_world
```

Not on npm — `github:` is the supported path. If you want a pinned install, append a tag or commit: `github:fangqiing/hello_world#e320550`.

## Configuration

Everything lives under the plugin's `config:` block. Defaults are in `lib/config.js`.

| Key | Default | Notes |
| --- | --- | --- |
| `companionName` | `助手` | Shown in the console and used as the persona fallback name. |
| `worldId` / `worldName` | `default` / `深海` | `worldId` selects the data subdirectory. Changing it gives you a clean slate without deleting anything. |
| `timeZone` | `Asia/Shanghai` | Drives rhythm, quiet hours and the nightly review. Validated on load. |
| `scope` | `all` | `all` = every new session in the profile; `workspace` = only sessions whose cwd is under `workspaceDir`. |
| `dataDir` | *(empty)* | Empty means `<DSH_HOME>/hello_world/<worldId>`. |
| `recallTopK` | `8` | Episodic rows pulled per turn before fusion. |
| `workingMemoryTokens` | `320` | Budget for the always-present working set. |
| `dailyTokenBudget` | `0` | `0` disables the cap. |
| `reviewTime` | `23:00` | Nightly consolidation trigger. |
| `quietHours` | `['23:30','08:00']` | No proactive messages inside this window, except a day-change greeting. |
| `proactiveDailyLimit` | `6` | Hard ceiling per day, on top of the per-period quota. |
| `allowExternalTools` | `false` | Lets channel-originated agents run shell/file tools. Leave off unless you have thought about it. |

### Providers

Copy `config/providers.example.json` to `config/providers.json` and fill in what you have. The file is gitignored. Nothing is required — with no providers configured the plugin runs entirely on the host model's own text ability, and only `see_image` / generation degrade.

The vision chain is tried in order and each entry can be disabled independently. A provider returning a refusal-flavoured answer (rather than an error) is treated as a failure and the chain steps to the next one.

## Tools

| Tool | Tier | Purpose |
| --- | --- | --- |
| `memory_search` | read | FTS5 + graph-expanded recall over episodes and facts. |
| `memory_read` | read | Fetch a specific memory or a time range. |
| `memory_remember` | write | Store an episode with importance and optional links. |
| `memory_update` | write | Revise or re-weight an existing row. |
| `see_image` | read | Vision chain over a local path or URL. |
| `weather_now` | read | Current conditions for a city. |
| `whale_status` | read | Mood, drives, current peer profile, memory counts. |
| `whale_peer` | read | Relationship state for one peer. |
| `whale_read` | read | Read recent conversation from a channel. |
| `whale_send` | write | Send text to a peer or group. |
| `whale_send_file` / `whale_send_text_file` | write | Send an attachment, or write text to a file and send it. |
| `whale_job_status` / `whale_job_cancel` | read | Track a long-running generation or shell job. |
| `whale_generate_image` | gated | DashScope async text-to-image (also used for stickers). |
| `whale_generate_video` | gated | DashScope async text-to-video. |
| `whale_host` | gated | Shell / file operations, low and high risk tiers. |
| `whale_disclose` | gated | Reveal that the companion is an AI, with a configured disclosure policy. |

`gated` means the two-stage confirmation above. `write` means it acts immediately but only within the peer's own conversation.

## Module map

`lib/` is grouped by concern rather than alphabetically:

- **Storage & recall** — `store.js`, `memory-hygiene.js`, `relevance.js`, `temporal-memory.js`, `dormant-traces.js`
- **Affect & drives** — `cognition.js`, `mood-engine.js`, `life.js`, `proactive-gate.js`, `rhythm-policy.js`
- **Voice** — `voice-style.js`, `voice-rules.js`, `voice-grice.js`, `voice-cleaner.js`, `voice-repair.js`, `voice-variants.js`, `voice-poetic.js`, `expression.js`
- **Relationships** — `social.js`, `peer-identity.js`, `peer-registry.js`, `per-peer-diary.js`, `growth.js`, `principle-engine.js`
- **Channels** — `channels.js`, `channel-admission.js`, `media-inbound.js`, `bridge-cursor.js`, `silk.js`, `asr-pipeline.js`
- **Media** — `vision-tool.js`, `generation.js`, `read-jobs.js`
- **Host & safety** — `host-tools.js`, `host-control.js`, `grant.js`, `auth-guard.js`, `disclosure-gate.js`, `mode-confirm.js`
- **Console** — `constellation-3d.js`, `constellation-layout.js`, `render-core.js`, `render-glow.js`, `web.js`

## Known limits

- **Vision** is only as good as the provider you configure. The chain degrades gracefully but cannot make a small model see better.
- **Video generation** parameters (`wan2.7-t2v`) are wired from the documented schema but have not been exercised end to end as much as image generation.
- **Constellation** wants roughly 2 MB of vendored `3d-force-graph` on first load. The vendored copy is served from the plugin, not a CDN, so it works offline.
- **Memory quality** depends on consolidation running. If the process is killed before the nightly review for many days, episodes accumulate and recall gets noisier — the decay curve keeps it bounded but not tidy.
- **Channel bridges** are a separate package. This bundle speaks to them through a local HTTP API; it does not implement the WeChat or QQ protocol itself.

## License

MIT. See `LICENSE`.

The image-prompt skill under `skills/image-prompt/` is adapted from MIT-licensed sources, credited in its front matter.
