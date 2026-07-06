# encoding: utf-8
# frozen_string_literal: true
#
# Sync classifier — shells to `claude -p` with a structured prompt to
# classify spec-diff hunks into task-level mutations.
#
# The classifier takes:
#   - spec_diff:        raw `git diff` output for spec.md (string)
#   - tasks_summary:    slim per-task entries (position, title, status,
#                       done_when, depends_on) — no full descriptions
#   - runbook_excerpt:  what the app currently can do (string)
#
# Returns an array of classification entries. Each entry:
#   {
#     "change_id" => "C-001",
#     "classification" => "new-task" | "modify-pending" | ... ,
#     "confidence" => "high" | "medium" | "low",
#     "spec_diff_hunk" => "@@ -142,3 +142,8 @@ ...",
#     "rationale" => "...",
#     "target" => { "position" => N, "depends_on" => [N, ...] },  # absent for refinement-noop
#     "task_payload" => { ... }  # absent or partial for refinement-noop / modify-pending
#   }
#
# Depends on stdlib only (json, open3). Raises ClassifierError on unrecoverable failure.

require "json"
require "open3"

module ScaffoldTask
  module SyncClassifier
    class ClassifierError < StandardError; end

    # The system prompt is kept here rather than in prompts/ so output
    # projects get it alongside the rest of bin/task infrastructure via
    # scaffold.sh's `cp templates/lib/scaffold_task/*.rb`. Operators can
    # tune per-project by editing this file in their generated project.
    SYSTEM_PROMPT = <<~PROMPT.freeze
      You are the scaffold sync classifier. Your job is to look at a diff of `spec.md` between two commits and classify each change hunk into one of five buckets. Your output drives `bin/task sync`, which proposes task-level mutations that an operator reviews before applying.

      ## Context

      Scaffold is a spec-to-build bootstrapper. A project's `spec.md` drives the initial task plan in `tasks.json`. Every task has a `done_when` clause (behavioral contract), a `position` (stable identifier), and `depends_on` edges. Tasks are built one at a time by an isolated coding-agent session; verification gates enforce the contract.

      The operator has iterated on `spec.md`. You see the diff. You classify each hunk. An operator reviews your classifications and accepts/rejects before tasks.json is mutated.

      ## The five classifications

      1. **new-task** — the hunk introduces a feature not covered by any existing task. Propose a full task object (title, description, user_story, done_when, labels, section_ref, acceptance_criteria). Set `target.depends_on` to completed prerequisites.

      2. **modify-pending** — the hunk changes the contract of a PENDING task (not yet built). Set `target.position` to that task. `task_payload` contains only the fields to overwrite. **Never modify-pending against a completed task.**

      3. **inject-against-completed** — the hunk requires a change affecting a feature already BUILT. Completed tasks are immutable; propose a NEW task whose `depends_on` includes the completed task. `task_payload` is a full task object.

      4. **deprecate** — the hunk REMOVES a feature. Propose a new task whose `done_when` proves ABSENCE (route returns 404, symbol not referenced, file deleted). Only with high confidence — if the hunk could be editorial cleanup, prefer `refinement-noop`.

      5. **refinement-noop** — wording change, reorganization, clarification, or formatting edit. No behavioral contract changes. No task generated.

      ## Rules

      - **Prefer `refinement-noop` over guessing.** Surfacing ambiguity is the right answer. The operator can manually add a task if needed.
      - **`confidence` must be honest.** `high` = unambiguous; `medium` = defensible but another option plausible; `low` = guessing or ambiguous, especially for deprecate vs. noop.
      - **Never modify-pending against a completed task.** Use inject-against-completed.
      - **Reason about `depends_on`.** Name the tasks that must be complete before this new task can begin.
      - **Output is JSON only.** No markdown, no commentary. Start with `[` and end with `]`.

      ## Output schema

      ```json
      [
        {
          "change_id": "C-001",
          "classification": "new-task" | "modify-pending" | "inject-against-completed" | "deprecate" | "refinement-noop",
          "confidence": "high" | "medium" | "low",
          "spec_diff_hunk": "@@ -142,3 +142,8 @@ ... (verbatim hunk header + body)",
          "rationale": "one-sentence explanation",
          "target": { "position": <integer>, "depends_on": [<integer>, ...] },
          "task_payload": {
            "title": "...",
            "description": "...",
            "user_story": "As a <role>, I <action> and <outcome>.",
            "done_when": "Observable behavior that proves completion.",
            "labels": ["backend"|"ui"|"data"|"integration"|"auth"|...],
            "section_ref": "Features > Subsection",
            "acceptance_criteria": [
              {"type": "file_exists"|"route_exists"|"http"|"command_exits"|"app_check", "params": {...}}
            ]
          }
        }
      ]
      ```

      For `refinement-noop`, set `target` and `task_payload` to null.
      For `modify-pending`, `task_payload` contains only the fields to overwrite — not a full task.

      ## If a single hunk covers multiple changes

      Split into sibling entries sharing a change_id prefix (C-001a, C-001b).

      Output ONLY the JSON array. Begin with `[`.
    PROMPT

    # Critic prompt: given the first-pass classification for ONE hunk,
    # ask Claude to challenge it. Used only for medium/low-confidence
    # entries (high-confidence entries are not re-sampled; paying 2x
    # across the board isn't worth it).
    #
    # The critic is instructed to either defend the first-pass call with
    # reasoning or propose a more defensible alternative. Output is a
    # single JSON object (not an array) matching the original schema.
    CRITIC_PROMPT = <<~PROMPT.freeze
      You are an adversarial reviewer for the scaffold sync classifier. The primary classifier has already classified one spec-diff hunk. Your job is to critique that classification.

      Rules you are reviewing against (same as the primary classifier):

      - Five classifications: new-task, modify-pending, inject-against-completed, deprecate, refinement-noop
      - **Never modify-pending against a completed task** — use inject-against-completed
      - **Prefer refinement-noop over guessing** when intent is ambiguous
      - `confidence: high` means unambiguous; `medium` = another option plausible; `low` = guessing

      Your output:
      - If the first-pass classification is defensible and you would not classify it differently, return it unchanged. You may keep or adjust the confidence level.
      - If you would classify it differently, return your preferred classification with `rationale` explaining why.
      - **Do not fabricate payload details.** If you disagree with the classification, the `task_payload` from the first pass may no longer fit — leave it as-is and let the operator reconcile.

      Output is a SINGLE JSON object (NOT an array) matching the same schema. No markdown, no commentary. Start with `{`.
    PROMPT

    def self.classify(spec_diff:, tasks_summary:, runbook_excerpt:, claude_path: nil)
      claude_path ||= `which claude 2>/dev/null`.strip
      raise ClassifierError, "claude CLI not found on PATH" if claude_path.empty?

      user_message = build_user_message(spec_diff, tasks_summary, runbook_excerpt)

      stdout, stderr, status = Open3.capture3(
        claude_path, "-p",
        "--max-turns", "3",
        "--model", "sonnet",
        "--append-system-prompt", SYSTEM_PROMPT,
        "--dangerously-skip-permissions",
        stdin_data: user_message
      )

      unless status.success?
        raise ClassifierError, "claude CLI exited #{status.exitstatus}: #{stderr.to_s[0..500]}"
      end

      parse_classifier_output(stdout)
    end

    def self.build_user_message(spec_diff, tasks_summary, runbook_excerpt)
      <<~MSG
        ## Spec diff (git diff between last_synced_spec_sha and HEAD, restricted to spec.md)

        ```diff
        #{spec_diff}
        ```

        ## Current tasks (slim summary)

        #{JSON.pretty_generate(tasks_summary)}

        ## Runbook excerpt (dependency-closure slice of what the app can do today)

        #{runbook_excerpt}

        ---

        Classify each coherent hunk of the diff above. Return ONLY the JSON array per the schema in the system prompt. Begin with `[`.
      MSG
    end

    # Run a critic pass against one first-pass classification entry.
    # Returns a hash:
    #   {
    #     "agreement" => "full" | "payload-divergent" | "classification-divergent",
    #     "critic_entry" => <the critic's JSON output>,
    #     "downgrade_confidence" => true | false  # true when classification diverges
    #   }
    def self.critique(entry, spec_diff:, tasks_summary:, runbook_excerpt:, claude_path: nil)
      claude_path ||= `which claude 2>/dev/null`.strip
      raise ClassifierError, "claude CLI not found on PATH" if claude_path.empty?

      user_message = <<~MSG
        ## Spec diff (same diff the primary classifier saw)

        ```diff
        #{spec_diff}
        ```

        ## Current tasks summary

        #{JSON.pretty_generate(tasks_summary)}

        ## Runbook excerpt

        #{runbook_excerpt}

        ## First-pass classification to critique

        ```json
        #{JSON.pretty_generate(entry)}
        ```

        Return a single JSON object per the schema in the system prompt. Begin with `{`.
      MSG

      stdout, stderr, status = Open3.capture3(
        claude_path, "-p",
        "--max-turns", "2",
        "--model", "sonnet",
        "--append-system-prompt", CRITIC_PROMPT,
        "--dangerously-skip-permissions",
        stdin_data: user_message
      )

      unless status.success?
        raise ClassifierError, "critic pass exited #{status.exitstatus}: #{stderr.to_s[0..500]}"
      end

      critic_entry = parse_critic_output(stdout)
      compare_entries(entry, critic_entry)
    end

    # Run the critic pass against every entry whose confidence is medium
    # or low. Returns the input array with each affected entry annotated:
    #   entry["double_sample_agreement"] = "full" | "payload-divergent" | "classification-divergent"
    #   entry["confidence"] = "low" if classification diverges
    #   entry["critic_rationale"] = critic's explanation (only on divergence)
    #
    # Entries with high confidence are returned unchanged (no critic call).
    def self.double_sample_if_uncertain(classifications, spec_diff:, tasks_summary:, runbook_excerpt:, claude_path: nil)
      classifications.map do |entry|
        next entry unless %w[medium low].include?(entry["confidence"].to_s)

        begin
          result = critique(entry, spec_diff: spec_diff, tasks_summary: tasks_summary,
                            runbook_excerpt: runbook_excerpt, claude_path: claude_path)
          annotated = entry.dup
          annotated["double_sample_agreement"] = result["agreement"]
          if result["downgrade_confidence"]
            annotated["confidence"] = "low"
            annotated["critic_rationale"] = result["critic_entry"]["rationale"]
            annotated["critic_classification"] = result["critic_entry"]["classification"]
          end
          annotated
        rescue ClassifierError => e
          # Critic pass failed — keep first-pass result but flag that
          # double-sampling was attempted and errored, so the operator
          # can treat confidence with extra skepticism.
          $stderr.puts "Critic pass failed for #{entry["change_id"]}: #{e.message}"
          entry.merge("double_sample_agreement" => "critic-error")
        end
      end
    end

    # Internal: compare first-pass and critic entries.
    def self.compare_entries(first, critic)
      first_class = first["classification"].to_s
      critic_class = critic["classification"].to_s

      if first_class != critic_class
        return {
          "agreement" => "classification-divergent",
          "critic_entry" => critic,
          "downgrade_confidence" => true
        }
      end

      # Same classification — check payload equivalence. For noop we
      # don't compare further. For other classifications, compare the
      # key contract fields: done_when + target.position + depends_on.
      return { "agreement" => "full", "critic_entry" => critic, "downgrade_confidence" => false } if first_class == "refinement-noop"

      first_done_when = first.dig("task_payload", "done_when").to_s.strip
      critic_done_when = critic.dig("task_payload", "done_when").to_s.strip
      first_depends = Array(first.dig("target", "depends_on")).sort
      critic_depends = Array(critic.dig("target", "depends_on")).sort

      if first_done_when != critic_done_when || first_depends != critic_depends
        return {
          "agreement" => "payload-divergent",
          "critic_entry" => critic,
          "downgrade_confidence" => false
        }
      end

      { "agreement" => "full", "critic_entry" => critic, "downgrade_confidence" => false }
    end

    # Internal: parse a single-object critic response.
    def self.parse_critic_output(raw)
      text = raw.to_s.strip
      return JSON.parse(text) if text.start_with?("{")

      if (m = text.match(/```(?:json)?\s*\n(\{.*?\})\s*\n```/m))
        return JSON.parse(m[1])
      end

      first = text.index("{")
      last = text.rindex("}")
      if first && last && last > first
        return JSON.parse(text[first..last])
      end

      raise ClassifierError, "critic output is not valid JSON: #{text[0..300]}"
    rescue JSON::ParserError => e
      raise ClassifierError, "critic output failed JSON parse: #{e.message}"
    end

    # Extract the JSON array from Claude's raw output, retrying with a
    # softer parse if the first attempt fails. Raises ClassifierError if
    # no parseable array can be recovered.
    def self.parse_classifier_output(raw)
      text = raw.to_s.strip

      # Try direct parse first
      return JSON.parse(text) if text.start_with?("[")

      # Strip markdown fences if the model added them despite instructions
      if (m = text.match(/```(?:json)?\s*\n(\[.*?\])\s*\n```/m))
        return JSON.parse(m[1])
      end

      # Last-ditch: find the first [ and last ]
      first_bracket = text.index("[")
      last_bracket = text.rindex("]")
      if first_bracket && last_bracket && last_bracket > first_bracket
        candidate = text[first_bracket..last_bracket]
        return JSON.parse(candidate)
      end

      raise ClassifierError, "classifier output is not valid JSON and no array could be extracted: #{text[0..300]}"
    rescue JSON::ParserError => e
      raise ClassifierError, "classifier output failed JSON parse: #{e.message}"
    end
  end
end
