#!/usr/bin/env ruby
# encoding: utf-8
# frozen_string_literal: true

Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

# extract_rules.rb — Extract architectural rules from a spec using Claude CLI
#
# Calls `claude -p` to extract spec-specific constraints, authorization patterns,
# data privacy rules, calculation formulas, and domain invariants.
#
# Usage:
#   ruby lib/extract_rules.rb --spec spec.md
#   ruby lib/extract_rules.rb --spec spec.md --output rules.md
#
# Outputs: markdown text (to stdout or file)

require "optparse"
require "open3"
require "tempfile"

options = {}
OptionParser.new do |opts|
  opts.banner = "Usage: extract_rules.rb --spec FILE [--output FILE]"
  opts.on("--spec FILE", "Path to spec.md") { |v| options[:spec] = v }
  opts.on("--output FILE", "Output file (default: stdout)") { |v| options[:output] = v }
end.parse!

abort "Missing --spec" unless options[:spec]
abort "Spec not found: #{options[:spec]}" unless File.exist?(options[:spec])

# Check if claude CLI is available
claude_path = `which claude 2>/dev/null`.strip
if claude_path.empty?
  $stderr.puts "Warning: claude CLI not found, skipping rule extraction"
  exit 0
end

spec_content = File.read(options[:spec])

prompt = <<~PROMPT
  You are extracting architectural rules and constraints from a software specification.
  These rules will be embedded in a CLAUDE.md file to guide AI coding agents during implementation.

  Read the specification below and extract:

  1. **Authorization & Access Control** — Who can see/do what? Any patterns like "return 404 instead of 403"?
  2. **Data Privacy Rules** — Which fields are private vs shared? Any visibility constraints?
  3. **Calculation Formulas** — Specific formulas, thresholds, rounding rules, scoring algorithms.
  4. **Business Invariants** — Rules that must always hold (e.g., "archived items excluded from progress").
  5. **Technical Constraints** — Database-specific rules, serialization patterns, file upload limits.
  6. **Notification Rules** — Deduplication, triggers, delivery constraints.

  Format as markdown sections. Be specific — include exact field names, thresholds, and formulas.
  Only include rules that are clearly stated in the spec. Do not infer or add rules.
  Keep each rule concise (1-2 sentences).

  If the spec doesn't contain rules for a category, omit that category entirely.

  SPECIFICATION:

  #{spec_content}
PROMPT

$stderr.puts "Extracting architectural rules from spec (calling claude)..."

# Use a tempfile for the prompt to avoid shell escaping issues
Tempfile.create(["prompt", ".txt"]) do |tmpfile|
  tmpfile.write(prompt)
  tmpfile.flush

  output, status = Open3.capture2(
    claude_path, "-p",
    "--max-turns", "1",
    stdin_data: prompt
  )

  unless status.success?
    $stderr.puts "Warning: claude CLI returned non-zero exit code, rule extraction may be incomplete"
  end

  result = output.strip

  if options[:output]
    File.write(options[:output], result)
    $stderr.puts "Extracted rules written to #{options[:output]}"
  else
    puts result
  end
end
