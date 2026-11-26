# Repo rules

## Versioning (every chat, every push)

The single version number is `"version"` in `feedmill-backend/package.json`. The HMI Update tab shows it
and compares it with the same file on the GitHub branch to decide whether an update is available, so an
unbumped push is invisible to the updater.

**Before every `git push`, increment it** (patch by default; minor/major only when the user says so):

```bash
cd feedmill-backend && npm version patch --no-git-tag-version
```

Include the bump (`package.json` + `package-lock.json`) in the commit being pushed. If the version on the
remote branch already equals the local one and there are new commits, bump before pushing.
