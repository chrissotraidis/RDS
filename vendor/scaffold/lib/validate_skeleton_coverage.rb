#!/usr/bin/env ruby
# encoding: utf-8
# frozen_string_literal: true

Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

# validate_skeleton_coverage.rb — Check that every detected stack has tasks
#
# Reads config.yml for detected_stacks and a skeleton/tasks JSON for task labels.
# Exits 0 if all stacks are covered, exits 1 with a corrective message if not.
#
# Usage:
#   ruby lib/validate_skeleton_coverage.rb \
#     --skeleton tasks-skeleton.json \
#     --config config.yml
#
# Also works with full tasks.json (same label structure).

require "json"
require "yaml"
require "optparse"

options = {}
OptionParser.new do |opts|
  opts.banner = "Usage: validate_skeleton_coverage.rb --skeleton FILE --config FILE"
  opts.on("--skeleton FILE", "Skeleton or full tasks JSON") { |v| options[:skeleton] = v }
  opts.on("--config FILE", "config.yml with detected_stacks") { |v| options[:config] = v }
end.parse!

abort "Missing --skeleton" unless options[:skeleton]
abort "Missing --config" unless options[:config]

# --- Load inputs ---
raw = JSON.parse(File.read(options[:skeleton], encoding: "UTF-8"))
tasks = if raw.is_a?(Hash) && raw["tasks"].is_a?(Array)
  raw["tasks"]
elsif raw.is_a?(Array)
  raw
else
  abort "Invalid tasks JSON: expected array or v2 wrapper object"
end
config = YAML.safe_load_file(options[:config])
detected_stacks = config["detected_stacks"] || []

exit(0) if detected_stacks.empty? || detected_stacks.size <= 1

# --- Map stacks to expected label patterns ---
STACK_LABEL_PATTERNS = {
  "rails"   => %w[backend rails api database],
  "node"    => %w[frontend node react next vue angular],
  "python"  => %w[backend python django flask fastapi],
  "ios"     => %w[ios swift swiftui xcode apple],
  "android" => %w[android kotlin jetpack compose],
  "flutter" => %w[flutter dart mobile cross-platform],
}.freeze

# --- Count tasks per stack ---
all_labels = tasks.flat_map { |t| (t["labels"] || []).map(&:downcase) }

missing_stacks = []

detected_stacks.each do |stack|
  patterns = STACK_LABEL_PATTERNS[stack] || [stack]
  count = all_labels.count { |label| patterns.any? { |p| label.include?(p) } }

  if count == 0
    missing_stacks << stack
  end
end

if missing_stacks.empty?
  # All stacks covered
  detected_stacks.each do |stack|
    patterns = STACK_LABEL_PATTERNS[stack] || [stack]
    count = all_labels.count { |label| patterns.any? { |p| label.include?(p) } }
    $stderr.puts "  #{stack}: #{count} task(s)"
  end
  exit(0)
else
  # Coverage gap — output corrective message and exit 1
  messages = missing_stacks.map do |stack|
    friendly = case stack
               when "ios" then "iOS/SwiftUI"
               when "android" then "Android/Kotlin"
               when "flutter" then "Flutter/Dart"
               else stack.capitalize
               end
    "Detected stack '#{stack}' has 0 implementation tasks. " \
      "The spec likely describes #{friendly} screens or components. " \
      "Add tasks for each #{friendly} screen with the '#{stack}' label."
  end

  # Also check bootstrap task covers all stacks
  bootstrap = tasks.find { |t| t["position"] == 0 }
  if bootstrap
    bootstrap_text = "#{bootstrap["title"]} #{bootstrap["section_ref"]}".downcase
    missing_in_bootstrap = detected_stacks.reject do |stack|
      patterns = STACK_LABEL_PATTERNS[stack] || [stack]
      patterns.any? { |p| bootstrap_text.include?(p) }
    end
    if missing_in_bootstrap.any?
      messages << "The bootstrap task (position 0) should scaffold ALL detected stacks: #{detected_stacks.join(", ")}. " \
        "Currently missing: #{missing_in_bootstrap.join(", ")}."
    end
  end

  $stdout.puts messages.join("\n")
  exit(1)
end
