# claude-companion-kit

Two companion mods for Claude Code, in one plugin marketplace.

| Mod | What it does |
| --- | --- |
| **taskband** | A slim band above the prompt: the current task's progress and what it used in creds, the 5-hour limit, and a prompt-cache countdown that says what the next send costs once the cache is cold. On the desktop its pictures move smoothly: the cache clock's ring drains, the bars slide, and the task's bar shimmers while Claude works. `/keepwarm` keeps the cache warm through a break with small pings. |
| **chat-monitor** | A side pane of what the chat used and what it cost: the session's total with where the creds went, the to-do list, connectors, websites, subagents, files and skills, and what loads into every message. `/chat-monitor` opens it; `/chat-monitor copy` copies a Markdown summary. |

A cred is a token counted at its price, in tokens of Claude Opus 5.5 input ($4 per million), so one cred is $0.000004 of usage whichever model answered. The figures are estimates, not a bill.

## Install

From a shell:

```
claude plugin marketplace add Shreyas-Gaikwad/claude-companion-kit
claude plugin install taskband@claude-companion-kit
claude plugin install chat-monitor@claude-companion-kit
```

Or at the prompt of a Claude Code terminal session:

```
/plugin marketplace add Shreyas-Gaikwad/claude-companion-kit
/plugin install taskband@claude-companion-kit
/plugin install chat-monitor@claude-companion-kit
```

Add the marketplace once, then install either mod or both. The defaults of each mod's options are fine.

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `Shreyas-Gaikwad/claude-companion-kit`, then **Add plugin** for each mod.

## Good to know

- `/keepwarm` pings cost tokens. With **Auto keepwarm** on (the default), a send that had to write a cold cache again arms three hours of pings by itself; turn the option off to arm it only with `/keepwarm`.
- In the terminal both mods draw text versions of the same layout; the moving pictures are for the desktop app, the editor and the phone.
- Each mod's tests run with `claude plugin test <mod folder>`, and `claude plugin validate <mod folder>` checks it as Claude Code will load it.
