---
name: testing-specialist
description: "Use when implementing testing, test suite, spec, or quality assurance tasks. Provides patterns for writing deterministic, independent tests mapped to specification scenarios. Examples: 'writing integration tests', 'adding model tests', 'creating system tests', 'testing API endpoints'"
---
# Testing Specialist

You are working on a testing task. Map every test to a GIVEN/WHEN/THEN
scenario from the spec. Tests must be deterministic, fast, and independent.
Mock all external services.

## Approach

1. **Read the spec first.** Check `section_ref` fields in the task and read the corresponding sections of `spec.md`. The GIVEN/WHEN/THEN scenarios ARE your test cases.
2. **One test per scenario.** Each GIVEN/WHEN/THEN becomes at least one test method.
3. **Test behavior, not implementation.** Test what the user sees and what the API returns, not internal method calls.
4. **No network dependencies.** Mock all external APIs with WebMock or VCR. Tests must pass on an airplane.

## Quality Criteria

Before marking the task done, verify:

- [ ] All tests pass with the project's test command
- [ ] No test depends on network access or external services
- [ ] No test depends on execution order (each test is independent)
- [ ] Each GIVEN/WHEN/THEN scenario from the spec has a corresponding test
- [ ] Edge cases from spec scenarios are covered (empty inputs, boundary values)
- [ ] Test data mirrors `db/seeds.rb` structure (fixtures or factories)
- [ ] Tests are fast (< 30 seconds for the full suite, excluding system tests)

## Verification Focus

When running verification commands, pay special attention to:
- All tests passing (zero failures, zero errors)
- No skipped tests without justification
- Test coverage of critical user flows

## Test Organization

- **Model tests:** Validations, associations, scopes, callbacks, business logic methods
- **Controller/request tests:** HTTP status codes, response body structure, authentication gates
- **System/integration tests:** Full user flows with browser simulation (headless Chrome)
- **Job tests:** Background job enqueueing and execution

## Common Pitfalls

- **Don't test framework code.** Don't test that `validates :name, presence: true` works. Test your business rules.
- **Don't use random data without seeds.** If using Faker, set `Faker::Config.random = Random.new(42)` for determinism.
- **Don't share state between tests.** Each test sets up its own data and tears it down. Use transactions or database cleaner.
- **Don't test private methods directly.** Test them through the public interface.
- **Don't skip flaky tests.** Fix them. A flaky test is a bug in the test, not a feature.
