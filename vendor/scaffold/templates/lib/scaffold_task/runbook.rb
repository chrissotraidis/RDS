# encoding: utf-8
# frozen_string_literal: true
#
# Runbook slicing and predecessor-telemetry helpers for bin/task.
#
# Depends on TELEMETRY_DIR and RUNBOOK_FILE constants defined in bin/task.
# require_relative this file from bin/task AFTER those are in scope.

# Transitive depends_on ancestors of `target`, BFS-walked from tasks.json.
# Returns {position => distance} (distance 1 = direct dep).
def dependency_distances(by_pos, target)
  distance = {}
  queue = [[target, 0]]
  until queue.empty?
    pos, d = queue.shift
    next unless by_pos[pos]
    Array(by_pos[pos]["depends_on"]).each do |dep|
      dep_i = dep.to_i
      next if distance.key?(dep_i) || dep_i == target
      distance[dep_i] = d + 1
      queue << [dep_i, d + 1]
    end
  end
  distance
end

# Parse runbook.md into { position => raw_section_text }.
def parse_runbook_sections
  sections = {}
  return sections unless File.exist?(RUNBOOK_FILE)
  current_pos = nil
  current_lines = []
  File.foreach(RUNBOOK_FILE, encoding: "utf-8") do |line|
    if (m = line.match(/\A### Task (\d+):/))
      sections[current_pos] = current_lines.join if current_pos
      current_pos = m[1].to_i
      current_lines = [line]
    elsif current_pos
      current_lines << line
    end
  end
  sections[current_pos] = current_lines.join if current_pos
  sections
end

# Dependency-closure slice of runbook.md for the given target, capped at
# `budget` bytes. Returns the formatted Markdown block (including headings
# and omission notice) or a fallback notice when nothing in-closure exists.
def runbook_closure_slice(target, by_pos, budget: 3000)
  distance = dependency_distances(by_pos, target)
  sections = parse_runbook_sections
  ancestors_with_entries = distance.keys.select { |p| sections.key?(p) }

  if ancestors_with_entries.empty?
    return [
      "_No prior runbook entries in this task's dependency closure._",
      "_The app state is effectively pre-bootstrap for this slice._"
    ].join("\n")
  end

  proximate_first = ancestors_with_entries.sort_by { |p| [distance[p], p] }
  emitted = []
  total = 0
  dropped = 0
  proximate_first.each do |pos|
    body = sections[pos]
    if total + body.bytesize > budget && !emitted.empty?
      dropped += 1
      next
    end
    emitted << pos
    total += body.bytesize
  end
  emitted.sort_by! { |pos| [-distance[pos], pos] }

  out = emitted.map { |pos| sections[pos] }.join
  out << "_(#{dropped} farther-ancestor runbook entries omitted to fit #{budget}-char budget)_\n" if dropped > 0
  out
end

# Most-recent predecessor telemetry restricted to the current task's
# transitive depends_on closure. Returns a Markdown summary or "".
def previous_task_summary(position, by_pos)
  return "" unless Dir.exist?(TELEMETRY_DIR)
  target = position.to_i
  return "" unless by_pos.key?(target)

  ancestors = dependency_distances(by_pos, target).keys
  return "" if ancestors.empty?

  candidates = ancestors
    .map { |p| [p, File.join(TELEMETRY_DIR, "#{p}.json")] }
    .select { |_, path| File.exist?(path) }
  return "" if candidates.empty?

  pos, path = candidates.max_by { |_, p| File.mtime(p) rescue Time.at(0) }
  data = begin
    JSON.parse(File.read(path, encoding: "utf-8"))
  rescue JSON::ParserError
    nil
  end
  return "" unless data.is_a?(Hash)

  title = data["title"].to_s
  state = data["verify_state"].to_s
  # The real remediation signal is `harness_failed_attempts` — verify runs
  # where the agent declared done but the harness disagreed. Plain
  # `failed_attempts` is source-agnostic and includes the agent's own
  # TDD-style probe failures, which aren't struggle, just iteration.
  #
  # Legacy telemetry (pre-source-split) doesn't have `harness_failed_attempts`
  # at all. Don't coerce-missing-to-zero and then claim "no remediation" —
  # we genuinely don't know. Detect absence via has_key? and degrade to a
  # neutral "source split unavailable" line when the record shows failures.
  has_source_split = data.key?("harness_failed_attempts")
  harness_failed_attempts = (data["harness_failed_attempts"] || 0).to_i
  total_failed_attempts = (data["failed_attempts"] || 0).to_i
  harness_invocations = (data["harness_invocations"] || 0).to_i
  files = Array(data["files_changed"]).reject { |f| f.to_s.strip.empty? }
  advisory_fails = Array(data["commands"]).select do |c|
    c.is_a?(Hash) && c["gate_type"] == "advisory" && c["passed"] == false
  end

  lines = []
  lines << "## Previous task outcome"
  lines << ""
  lines << "- Task #{pos}: #{title}"
  lines << "- verify_state: #{state}"
  if has_source_split
    if harness_failed_attempts > 0
      lines << "- harness fix passes: #{harness_failed_attempts} (predecessor needed remediation — consider why)"
    elsif harness_invocations > 1
      lines << "- harness invocations: #{harness_invocations} (clean reruns; no remediation)"
    end
  elsif total_failed_attempts > 0
    lines << "- failed verifications: #{total_failed_attempts} (source split unavailable in legacy telemetry — could be harness remediation or agent iteration)"
  end
  unless advisory_fails.empty?
    lines << "- advisory checks that failed:"
    advisory_fails.first(5).each do |c|
      name = c["name"] || "(unnamed)"
      code = c["exit_code"] || c["code"] || "?"
      lines << "  - #{name} (exit #{code})"
    end
  end
  unless files.empty?
    shown = files.first(10)
    lines << "- files_changed (first #{shown.length} of #{files.length}):"
    shown.each { |f| lines << "  - #{f}" }
  end
  lines << ""
  lines << "Use this as context only; do not re-verify or revert predecessor work."
  lines.join("\n")
end
