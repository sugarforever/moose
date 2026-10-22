# Skill Folder Implementation Plan

**Goal:** Install and inspect complete Skill folders and use their files through available tools.
**Architecture:** Pin GitHub folder listings to a commit, persist bounded base64 files in Skill metadata, read installed resources and materialize fresh workspace copies on explicit tool use.
**Tech Stack:** portable TypeScript, GitHub REST API, Pi ExecutionEnv, SQLite, React Native.
**Spec:** docs/skill-folders.md

## Constraints and review focus

No automatic execution or credentials. Preserve bytes and relative paths. Reject unsafe paths, symlinks, truncated listings, oversized downloads and invalid instruction files. Preserve legacy imports. Disabled/uninstalled skills cannot materialize files. Binary preview must not decode as executable markup.

- [ ] Add failing folder download and bounds tests to tests/skills.test.ts; implement src/skills/bundle.ts and loadSkill integration.
- [ ] Add failing resource tests; serve installed text from CapabilityService.
- [ ] Add real workspace tests; implement skill_workspace in src/runtime/skill-workspace.ts and register it in engine.ts.
- [ ] Add file chooser/text preview to SkillsScreen and update README/tool guidance.
- [ ] Run full verify, review, PR checks and merge.
- [ ] Bump minor version, tag and verify published release artifacts.
