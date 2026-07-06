#!/usr/bin/env ruby
# frozen_string_literal: true

require "json"
require "minitest/autorun"
require "open3"
require "pathname"
require "tmpdir"
require "fileutils"
require "yaml"

class SpecCoverageIntegrationTest < Minitest::Test
  SCRIPT_PATH = Pathname.new(__dir__).join("..", "templates", "bin", "spec_coverage").expand_path
  VALIDATE_TASKS_PATH = Pathname.new(__dir__).join("..", "lib", "validate_tasks.rb").expand_path

  def run_coverage(spec:, tasks:, config: {})
    Dir.mktmpdir("spec-coverage-test") do |dir|
      File.write(File.join(dir, "spec.md"), spec)
      File.write(File.join(dir, "tasks.json"), JSON.pretty_generate(tasks))
      File.write(File.join(dir, "config.yml"), YAML.dump(config))

      stdout, stderr, status = Open3.capture3("ruby", SCRIPT_PATH.to_s, "--json", chdir: dir)
      assert status.success?, "spec_coverage failed\nSTDOUT:\n#{stdout}\nSTDERR:\n#{stderr}"
      JSON.parse(stdout)
    end
  end

  def run_validate_tasks(spec:, raw_tasks:, wiki: nil)
    result = run_validate_tasks_result(spec: spec, raw_tasks: raw_tasks, wiki: wiki)
    assert result[:status].success?, "validate_tasks failed\nSTDOUT:\n#{result[:stdout]}\nSTDERR:\n#{result[:stderr]}"
    JSON.parse(result[:stdout])
  end

  def run_validate_tasks_result(spec:, raw_tasks:, wiki: nil)
    Dir.mktmpdir("validate-tasks-test") do |dir|
      spec_path = File.join(dir, "spec.md")
      File.write(spec_path, spec)

      command = ["ruby", VALIDATE_TASKS_PATH.to_s, "--recipe-type", "web_app", "--spec", spec_path]
      command += ["--wiki", wiki] if wiki

      stdout, stderr, status = Open3.capture3(*command, stdin_data: JSON.generate(raw_tasks))
      { stdout: stdout, stderr: stderr, status: status }
    end
  end

  def test_ignores_deferred_and_testing_sections
    payload = run_coverage(
      spec: <<~MD,
        # 1. Features

        - GIVEN a coach signs in
        - WHEN they open the dashboard
        - THEN they see their client roster

        # 10. Future Considerations

        - Mobile App / PWA: native apps for offline use.

        # Testing Strategy

        - Coverage targets: keep tests fast.
        - CI: `bin/rails test:all` must pass.
      MD
      tasks: {
        "schema_version" => 2,
        "tasks" => [
          {
            "position" => 1,
            "title" => "Coach dashboard",
            "done_when" => "Coach opens dashboard and sees client roster.",
            "user_story" => "As a coach, I sign in and view my dashboard roster."
          }
        ]
      }
    )

    assert_equal 1, payload["total_requirements"]
    assert_equal 1, payload.dig("scenarios", "total")
    assert_equal 0, payload.dig("attributes", "total")
    assert_equal 0, payload.dig("rules", "total")
  end

  def test_does_not_treat_view_prose_as_attributes
    payload = run_coverage(
      spec: <<~MD,
        # 1. Features

        - GIVEN a coach signs in
        - WHEN they open the dashboard
        - THEN they see their client roster

        # 5. Views & Interfaces

        - Dashboard (Coach)
          - Purpose: central hub showing client list and quick actions.
          - Information displayed: client tiles and pending invitations.
          - Actions: create client, search, filter.
          - Navigation: leads to client profile and settings.
      MD
      tasks: {
        "schema_version" => 2,
        "tasks" => []
      }
    )

    assert_equal 1, payload["total_requirements"]
    assert_equal 0, payload.dig("attributes", "total")
  end

  def test_extracts_entity_attributes_from_bullet_lists
    payload = run_coverage(
      spec: <<~MD,
        # 3. Entities & Data Model

        - Client
          - Attributes:
            - id, coach_id, email_address, archived_at
          - Relationships:
            - belongs_to :coach
      MD
      tasks: {
        "schema_version" => 2,
        "tasks" => []
      }
    )

    assert_equal 4, payload.dig("attributes", "total")
    uncovered_ids = payload["uncovered_requirements"].map { |req| req["id"] || req[:id] }
    assert_includes uncovered_ids, "ATTR-Client-id"
    assert_includes uncovered_ids, "ATTR-Client-coach_id"
    assert_includes uncovered_ids, "ATTR-Client-email_address"
    assert_includes uncovered_ids, "ATTR-Client-archived_at"
  end

  def test_reclassifies_business_rules_without_counting_them_as_attributes
    payload = run_coverage(
      spec: <<~MD,
        # 3. Entities & Data Model

        - PlanObjective
          - Attributes:
            - id, progress_percent
          - Business rules:
            - `progress_percent` is a computed cache, updated synchronously whenever a child task's status changes.

        # 7. Logic & Calculations

        - Normalized Scale: convert 1–5 to 0–100.
        - Example: average 4.0 => 75%.
      MD
      tasks: {
        "schema_version" => 2,
        "tasks" => []
      }
    )

    assert_equal 2, payload.dig("attributes", "total")
    assert_equal 2, payload.dig("rules", "total")
    uncovered_texts = payload["uncovered_requirements"].map { |req| req["text"] || req[:text] }
    assert_includes uncovered_texts, "`progress_percent` is a computed cache, updated synchronously whenever a child task's status changes."
    assert_includes uncovered_texts, "Normalized Scale: convert 1–5 to 0–100."
  end

  def test_requirement_refs_allow_exact_coverage_without_fuzzy_text_match
    payload = run_coverage(
      spec: <<~MD,
        ## Features

        ### Requirement: Invitation Flow [REQ-AUTH-001]
        - GIVEN a coach sends an invitation
        - WHEN the client opens the link
        - THEN the system accepts the invitation
      MD
      tasks: {
        "schema_version" => 2,
        "tasks" => [
          {
            "position" => 1,
            "title" => "Handle invite acceptance",
            "done_when" => "The invite workflow is complete.",
            "user_story" => "As a user, I complete signup.",
            "requirement_refs" => ["REQ-AUTH-001"]
          }
        ]
      }
    )

    assert_equal 1, payload["covered"]
    assert_equal 100.0, payload["coverage_percent"]
  end

  def test_validate_tasks_infers_requirement_refs_from_unambiguous_section
    doc = run_validate_tasks(
      spec: <<~MD,
        ## Features

        ### Requirement: Invitation Flow [REQ-AUTH-001]
        - GIVEN a coach sends an invitation
        - WHEN the client opens the link
        - THEN the system accepts the invitation
      MD
      raw_tasks: [
        {
          "title" => "Handle invite acceptance",
          "position" => 1,
          "depends_on" => [0],
          "labels" => ["backend"],
          "section_ref" => "Features",
          "user_story" => "As a user, I complete signup.",
          "done_when" => "The invite workflow is complete."
        }
      ]
    )

    task = doc.fetch("tasks").find { |entry| entry["title"] == "Handle invite acceptance" }
    assert_equal ["REQ-AUTH-001"], task["requirement_refs"]
    assert_equal ["REQ-AUTH-001"], doc.dig("spec_metadata", "requirement_audit", "active_requirement_refs")
    assert_equal ["REQ-AUTH-001"], doc.dig("spec_metadata", "requirement_audit", "covered_requirement_refs")
  end

  def test_validate_tasks_fails_when_active_requirement_has_no_owner
    result = run_validate_tasks_result(
      spec: <<~MD,
        ## Features

        ### Requirement: Invitation Flow [REQ-AUTH-001]
        - GIVEN a coach sends an invitation
        - WHEN the client opens the link
        - THEN the system accepts the invitation
      MD
      raw_tasks: [
        {
          "title" => "Bootstrap project",
          "position" => 0,
          "depends_on" => [],
          "labels" => ["setup"],
          "section_ref" => "Overview",
          "user_story" => "As a developer, I boot the app.",
          "done_when" => "The app boots."
        }
      ]
    )

    refute result[:status].success?
    assert_includes result[:stderr], "Requirement coverage audit failed"
    assert_includes result[:stderr], "REQ-AUTH-001"
  end

  def test_validate_tasks_preserves_dependencies_after_risk_informed_reordering
    Dir.mktmpdir("validate-tasks-wiki") do |wiki_dir|
      FileUtils.mkdir_p(File.join(wiki_dir, "operations"))
      File.write(
        File.join(wiki_dir, "operations", "risks-and-known-gaps.md"),
        <<~MD
          ## RISK-001: Account data exposure — Severity: HIGH
          Impacts `User`.
        MD
      )

      doc = run_validate_tasks(
        spec: "## Overview\n\n- Bootstrap the app.\n",
        wiki: wiki_dir,
        raw_tasks: [
          {
            "title" => "Bootstrap project",
            "position" => 0,
            "depends_on" => [],
            "labels" => ["setup"],
            "section_ref" => "Overview",
            "user_story" => "As a developer, I boot the app.",
            "done_when" => "The app boots."
          },
          {
            "title" => "Prepare authenticated shell",
            "position" => 1,
            "depends_on" => [0],
            "labels" => ["backend"],
            "section_ref" => "Overview",
            "user_story" => "As a user, I sign in.",
            "done_when" => "The authenticated shell renders."
          },
          {
            "title" => "Load dashboard data",
            "position" => 2,
            "depends_on" => [1],
            "labels" => ["backend"],
            "section_ref" => "Overview",
            "user_story" => "As a user, I load my dashboard.",
            "done_when" => "The dashboard data loads."
          },
          {
            "title" => "Seed reference data",
            "position" => 3,
            "depends_on" => [],
            "labels" => ["data"],
            "section_ref" => "Overview",
            "user_story" => "As a developer, I seed lookup data.",
            "done_when" => "Reference data exists locally."
          }
        ]
      )

      tasks = doc.fetch("tasks").sort_by { |task| task["position"] }
      positions = tasks.to_h { |task| [task["title"], task["position"]] }

      assert_equal [0], tasks.find { |task| task["title"] == "Prepare authenticated shell" }["depends_on"]
      assert_equal [positions.fetch("Prepare authenticated shell")], tasks.find { |task| task["title"] == "Load dashboard data" }["depends_on"]
      assert tasks.all? { |task| task["depends_on"].all? { |dep| dep < task["position"] } }, "expected all dependencies to point to earlier tasks"
    end
  end
end
