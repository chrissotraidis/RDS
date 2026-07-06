# encoding: utf-8
# frozen_string_literal: true
#
# Drift detection for completed tasks.
#
# A task that was marked done at build time may no longer reflect its
# `done_when` criteria. Common causes: someone reverted the task's commit,
# a later refactor removed the feature, or the spec changed (which sync
# handles separately). Drift detection walks every completed task,
# re-runs a cheap subset of its verification primitives against current
# code state, and flags tasks whose probes now fail.
#
# Scope of "cheap":
#   - Pure file scans (reading source files, grepping for patterns)
#   - Structural checks that don't require a running app
#   - Excluded: HTTP probes (need a runtime), `bin/rails` commands
#     (slow, need DB), anything referencing $APP_BASE_URL
#
# For full-fidelity drift detection, the operator should run
# `bin/task verify N` against a live runtime — that re-runs the complete
# gate. Drift detection is an advisory layer; it surfaces likely drift
# quickly without spinning up a server.
#
# Depends on TELEMETRY_DIR and DETAIL_DIR from bin/task.

require "json"
require "open3"
require "timeout"

module ScaffoldTask
  module Drift
    # Commands that reference these markers are skipped — they need a
    # running app or a configured framework, which drift detection
    # deliberately avoids.
    HTTP_PROBE_MARKER = /\$APP_BASE_URL/.freeze
    RAILS_CMD_MARKER = /\bbin\/rails\b/.freeze
    NPM_CMD_MARKER = /\b(npm|yarn|pnpm)\s+(test|run)\b/.freeze
    PROBE_TIMEOUT_SECONDS = 15

    # Returns a list of drift reports, one per completed task that has
    # at least one cheap probe failing. Tasks whose probes all pass (or
    # whose probes are all expensive and skipped) are omitted.
    #
    # Each report:
    #   {
    #     position: Integer,
    #     title: String,
    #     probes_run: Integer,
    #     probes_skipped: Integer,
    #     failures: [ { name:, primitive_type:, exit_code:, stderr_head: }, ... ]
    #   }
    def self.detect(tasks, detail_dir:)
      completed = tasks.select { |t| t["status"] == "done" }
      reports = []

      completed.each do |task|
        detail_path = File.join(detail_dir, "#{task["position"]}.json")
        next unless File.exist?(detail_path)

        commands = extract_commands(detail_path)
        next if commands.empty?

        cheap = commands.select { |c| cheap_probe?(c["command"].to_s) }
        skipped = commands.length - cheap.length
        failures = []

        cheap.each do |cmd|
          result = run_probe(cmd["command"].to_s)
          next if result[:passed]

          failures << {
            name: cmd["name"],
            primitive_type: cmd["primitive_type"],
            exit_code: result[:exit_code],
            stderr_head: result[:stderr_head]
          }
        end

        next if failures.empty?

        reports << {
          position: task["position"],
          title: task["title"],
          probes_run: cheap.length,
          probes_skipped: skipped,
          failures: failures
        }
      end

      reports
    end

    # Render a drift report list as a markdown section. Returns "" when
    # no drift detected so callers can interpolate the result
    # unconditionally.
    def self.render_markdown(reports)
      return "" if reports.empty?

      out = []
      out << "## ⚠️  Drift detected"
      out << ""
      out << "The following completed tasks have probes that no longer pass against current code. "\
             "This is an advisory — spec changes are handled separately by sync. To confirm a drift, "\
             "run `bin/task verify N --skip-runtime-deps` against a live runtime for the full gate."
      out << ""
      out << "| Task | Title | Failing probes |"
      out << "|------|-------|-----------------|"
      reports.each do |r|
        failure_summary = r[:failures].first(3).map { |f| "`#{f[:name]}`" }.join(", ")
        failure_summary += " (+#{r[:failures].length - 3} more)" if r[:failures].length > 3
        out << "| #{r[:position]} | #{escape_md(r[:title])} | #{failure_summary} |"
      end
      out << ""
      out << "<details><summary>Details</summary>"
      out << ""
      reports.each do |r|
        out << "### Task #{r[:position]}: #{r[:title]}"
        out << ""
        out << "- Probes run: #{r[:probes_run]}"
        out << "- Probes skipped (needed runtime): #{r[:probes_skipped]}" if r[:probes_skipped] > 0
        out << "- Failures:"
        r[:failures].each do |f|
          out << "  - **#{f[:name]}** (`#{f[:primitive_type]}`, exit #{f[:exit_code]})"
          if f[:stderr_head] && !f[:stderr_head].empty?
            out << "    ```"
            out << "    #{f[:stderr_head]}"
            out << "    ```"
          end
        end
        out << ""
      end
      out << "</details>"
      out.join("\n")
    end

    # Internal: extract verification commands from a task-details JSON.
    def self.extract_commands(detail_path)
      raw = JSON.parse(File.read(detail_path, encoding: "utf-8"))
      Array(raw.dig("verification", "commands"))
    rescue JSON::ParserError, Errno::ENOENT
      []
    end

    # Internal: cheap probes are purely file-scanning. Anything that hits
    # a running server, database, or framework test runner is deferred
    # to `bin/task verify` on a live runtime.
    def self.cheap_probe?(command)
      return false if command.empty?
      return false if command.match?(HTTP_PROBE_MARKER)
      return false if command.match?(RAILS_CMD_MARKER)
      return false if command.match?(NPM_CMD_MARKER)
      true
    end

    # Internal: run a single probe command with a timeout. Returns
    # { passed:, exit_code:, stderr_head: }.
    def self.run_probe(command)
      stdout = ""
      stderr = ""
      status = nil

      begin
        Timeout.timeout(PROBE_TIMEOUT_SECONDS) do
          stdout, stderr, status = Open3.capture3({ "LC_ALL" => "C" }, "bash", "-c", command)
        end
      rescue Timeout::Error
        return { passed: false, exit_code: -1, stderr_head: "probe exceeded #{PROBE_TIMEOUT_SECONDS}s timeout" }
      rescue StandardError => e
        return { passed: false, exit_code: -1, stderr_head: "probe error: #{e.message[0..200]}" }
      end

      {
        passed: status&.success? == true,
        exit_code: status&.exitstatus || -1,
        stderr_head: (stderr.to_s.strip[0..300] rescue "")
      }
    end

    def self.escape_md(text)
      text.to_s.gsub("|", "\\|")
    end
  end
end
