# llm-pydantic-ai

Python agent and structured-output contract for AI service builds.

Applies to: python-ai-service
Category: llm
Maturity: operational

Use when:
- The selected stack is `python-ai-service`.
- The service needs LLM calls, extraction, classification, tool use, evals, typed outputs, RAG orchestration, or agent workflows.

Implementation contract:
- Put provider configuration behind environment variables; never hardcode model keys or secrets.
- Represent LLM inputs/outputs with Pydantic models so API responses and tests are typed.
- Separate transport routes, domain logic, provider adapters, and evaluation fixtures.
- Include deterministic fallback/stub behavior when credentials are missing so preview still explains what is blocked.
- Add small eval fixtures for core prompts or extraction contracts instead of relying on one happy-path request.

Verification:
- Run Python compile/tests.
- Hit the FastAPI health endpoint and at least one representative API route.
- Validate response schema and missing-credential behavior.
- Save sample request/response or eval output in build artifacts.

Source references:
- Pydantic AI: https://ai.pydantic.dev/
- Pydantic: https://docs.pydantic.dev/
