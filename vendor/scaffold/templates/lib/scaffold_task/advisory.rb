# encoding: utf-8
# frozen_string_literal: true
#
# Circuit-breaker advisory helpers for bin/task.
#
# Depends on TELEMETRY_DIR and `load_tasks` defined in bin/task. require_relative
# this file from bin/task AFTER those are in scope.

ATTEMPT_WARNING_THRESHOLD_DEFAULT = 8

def attempt_warning_threshold
  raw = ENV["SCAFFOLD_ATTEMPT_WARNING_THRESHOLD"].to_s.strip
  return ATTEMPT_WARNING_THRESHOLD_DEFAULT if raw.empty?
  parsed = Integer(raw) rescue nil
  return ATTEMPT_WARNING_THRESHOLD_DEFAULT if parsed.nil? || parsed <= 0
  parsed
end

def telemetry_failed_attempt_count(position)
  # Only harness-driven failures count as struggle for the split advisory.
  # Agent self-probe failures are normal TDD iteration and shouldn't trigger
  # "you should split this task" suggestions.
  path = File.join(TELEMETRY_DIR, "#{position.to_i}.json")
  return 0 unless File.exist?(path)
  data = JSON.parse(File.read(path, encoding: "utf-8"))
  (data["harness_failed_attempts"] || 0).to_i
rescue JSON::ParserError, Errno::ENOENT
  0
end

# Heuristic split of a done_when string into candidate child contracts.
# Tries successively coarser delimiters; keeps clauses >= 40 chars.
# Returns [] if it cannot produce >= 2 viable clauses.
def heuristic_split_done_when(done_when)
  text = done_when.to_s.strip
  return [] if text.empty?

  delimiters = [
    /\s*;\s*/,
    /\s+AND\s+/i,
    /,\s+and\s+/i,
    /\s+and\s+then\s+/i,
    /\s*→\s*/,
    /\s*->\s*/
  ]

  delimiters.each do |delim|
    parts = text.split(delim).map(&:strip).reject(&:empty?)
    next if parts.size < 2
    viable = parts.select { |p| p.length >= 40 }
    # Merge short trailing fragments into the previous viable clause.
    if viable.size < parts.size
      merged = []
      parts.each do |p|
        if p.length >= 40 || merged.empty?
          merged << p
        else
          merged[-1] = "#{merged[-1]}; #{p}"
        end
      end
      viable = merged.select { |p| p.length >= 40 }
    end
    next if viable.size < 2
    return viable.first(5)
  end

  []
end

# Emits a multi-line advisory suggesting `bin/task split` once failed attempts
# cross the threshold. Returns "" when no advisory is warranted so callers can
# safely interpolate the result unconditionally.
def attempt_advisory_for(position)
  pos = position.to_i
  failed_attempts = telemetry_failed_attempt_count(pos)
  threshold = attempt_warning_threshold
  return "" if failed_attempts < threshold

  task = load_tasks.find { |t| t["position"] == pos }
  return "" unless task
  done_when = task["done_when"].to_s

  clauses = heuristic_split_done_when(done_when)

  lines = []
  lines << "⚠️ The harness has sent this task back for remediation #{failed_attempts} times. Consider splitting it via:"
  if clauses.size >= 2
    quoted = clauses.map { |c| %("#{c.gsub('"', '\\"')}") }.join(" ")
    lines << "  bin/task split #{pos} #{quoted}"
    lines << "The done_when reads like multiple contracts bundled together:"
    clauses.each { |c| lines << "  - #{c}" }
  else
    lines << %(  bin/task split #{pos} "<child contract 1>" "<child contract 2>" ...)
    lines << "The done_when could not be auto-segmented; propose your own contracts based on the behavior it bundles."
  end
  lines << "Splitting is preferable to forcing another fix attempt."
  lines.join("\n")
end
