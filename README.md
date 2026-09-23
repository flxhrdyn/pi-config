# pi-config

Personal configuration and extensions for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent).

## Structure

```
~/.pi/agent/
├── extensions/
│   ├── custom-footer.ts   # Clean Vim statusline & custom widgets
│   └── themes.ts          # Theme switcher extension (/themes)
├── themes/                # Custom color themes (gruvbox, tokyo-night, catppuccin, etc.)
├── skills/                # Agent prompt skills & superpowers
├── settings.json          # Core agent preferences
└── AGENTS.md              # Global project guidelines & prompt instructions
```

## Features

- **Custom Statusline**: Vim-inspired minimal footer with mode, active model, git branch & diff status, token & context window percentage.
- **Image Handling**: Intercepts and badges pasted clipboard images (`[Image #N]`).
- **Semantic Theming**: Fully adaptive to all installed themes via theme color tokens.

## Restore / Sync

Clone or pull into `~/.pi/agent`:

```bash
git clone https://github.com/flxhrdyn/pi-config.git ~/.pi/agent
```

> **Note**: Secrets (`auth.json`, `9router-config.json`, `models-store.json`) and session logs (`sessions/`) are excluded via `.gitignore`.
