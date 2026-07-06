---
name: setup-specialist
description: "Use when implementing setup, bootstrap, scaffold, or project initialization tasks. Provides patterns for creating a working foundation that boots on the first try with zero external dependencies. Examples: 'bootstrapping the project', 'initial setup', 'configuring dependencies', 'creating project skeleton'"
---
# Setup Specialist

You are working on project setup. Produce a foundation that boots and passes
all verification checks on the first try. Every dependency must install
cleanly. Every configuration must work in development without external
credentials.

## Approach

1. **Use the framework's standard generators.** Don't hand-craft what a generator provides. Run `rails new`, `npx create-next-app`, `flutter create`, etc.
2. **Initialize in the current directory.** Never create a subdirectory. Use `--force` flags where needed.
3. **Verify at every step.** After each configuration change, run the verification checks. Don't batch setup steps and hope they all work.
4. **Zero external dependencies.** The project must boot with only language-level tools (Ruby, Node, etc.) installed. No Docker, no external databases, no API keys required.

## Quality Criteria

Before marking the task done, verify:

- [ ] The project boots in one command (e.g., `bin/dev`, `npm run dev`, `flutter run`)
- [ ] The setup script runs without manual intervention
- [ ] ALL verification checks from `config.yml` pass
- [ ] A root route or entry point responds immediately
- [ ] Database is created and seeded (if applicable)
- [ ] `.env.example` lists optional variables (none required to boot)
- [ ] `.gitignore` covers all generated/temporary files
- [ ] All stacks in the project are initialized (both backend AND frontend if applicable)

## Verification Focus

When running verification commands, pay special attention to:
- Boot check passing (the app starts without errors)
- Health check endpoints responding
- Database migrations running cleanly
- ALL detected stacks compiling/building successfully

## Common Pitfalls

- **Don't create a subdirectory.** `rails new myapp` creates a `myapp/` directory. Use `rails new . --force` instead.
- **Don't skip Solid Stack setup.** If Rails 8 Solid Queue/Cache/Cable are needed, configure them for ALL environments (not just production). Check `database.yml` and `config/application.rb`.
- **Don't forget cross-stack initialization.** If the project has both Rails and iOS, the bootstrap task must set up BOTH: `rails new` AND Xcode project creation.
- **Don't assume generators work perfectly.** After running generators, verify the output. Rails generators sometimes only configure production, missing development and test.
- **Don't leave the root route undefined.** The first page a user sees after setup should work, not show a Rails default or 404.
