#!/usr/bin/env ruby
# encoding: utf-8
# frozen_string_literal: true

Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

# extract_screens.rb — Phase A of mockup generation
#
# Analyzes spec.md + tasks.json to produce a mockup-manifest.json that
# describes every screen, navigation structure, roles, and seed data.
#
# Usage:
#   ruby lib/extract_screens.rb \
#     --spec spec.md \
#     --tasks tasks.json \
#     --primary-recipe library/recipes/web_app.yml \
#     [--supporting-recipes library/recipes/mobile_app.yml] \
#     [--domains library/domain_types/social.yml] \
#     --output mockup-manifest.json

require "json"
require "yaml"
require "erb"
require "optparse"
require "open3"
require "fileutils"

options = { supporting_recipes: [], domains: [] }
OptionParser.new do |opts|
  opts.banner = "Usage: extract_screens.rb --spec FILE --tasks FILE --primary-recipe FILE --output FILE"
  opts.on("--spec FILE", "Specification file") { |v| options[:spec] = v }
  opts.on("--tasks FILE", "Tasks JSON file") { |v| options[:tasks] = v }
  opts.on("--primary-recipe FILE", "Primary recipe YAML") { |v| options[:primary_recipe] = v }
  opts.on("--supporting-recipes LIST", "Comma-separated supporting recipe YAMLs") do |v|
    options[:supporting_recipes] = v.split(",").map(&:strip)
  end
  opts.on("--domains LIST", "Comma-separated domain type YAMLs") do |v|
    options[:domains] = v.split(",").map(&:strip)
  end
  opts.on("--output FILE", "Output manifest JSON path") { |v| options[:output] = v }
end.parse!

%i[spec tasks primary_recipe output].each do |key|
  abort "Missing --#{key.to_s.tr('_', '-')}" unless options[key]
end

# ─── Load inputs ───

spec_content = File.read(options[:spec], encoding: "UTF-8")
raw_tasks = JSON.parse(File.read(options[:tasks], encoding: "UTF-8"))
all_tasks = if raw_tasks.is_a?(Hash) && raw_tasks["tasks"].is_a?(Array)
  raw_tasks["tasks"]
elsif raw_tasks.is_a?(Array)
  raw_tasks
else
  abort "Invalid tasks.json: expected array or v2 wrapper object"
end

# Extract frontend-relevant tasks
frontend_tasks = all_tasks.select do |t|
  labels = (t["labels"] || []).map(&:downcase)
  labels.include?("frontend") ||
    labels.include?("views") ||
    labels.include?("ui") ||
    (t["title"] || "").downcase.match?(/view|screen|dashboard|form|page|layout|navigation/)
end

# If no explicit frontend tasks, include all tasks (spec may describe UI in non-labeled tasks)
frontend_tasks = all_tasks if frontend_tasks.empty?

tasks_content = frontend_tasks.map do |t|
  "- [#{t["position"]}] #{t["title"]} (labels: #{(t["labels"] || []).join(", ")}; section: #{t["section_ref"]})"
end.join("\n")

# ─── Build technology context ───

primary_recipe = YAML.safe_load_file(options[:primary_recipe], permitted_classes: [Symbol])
supporting_recipes = options[:supporting_recipes].filter_map do |path|
  YAML.safe_load_file(path, permitted_classes: [Symbol]) if File.exist?(path)
end
domains = options[:domains].filter_map do |path|
  YAML.safe_load_file(path, permitted_classes: [Symbol]) if File.exist?(path)
end

scaffold_dir = File.expand_path("..", __dir__)

# Render prompts using render_prompt.rb's ERB approach
system_template_path = File.join(scaffold_dir, "prompts", "screen_extraction_system.md.erb")
user_template_path = File.join(scaffold_dir, "prompts", "screen_extraction_user.md.erb")

# Build technology_context (same pattern as hydrate_tasks.rb)
def str(val)
  val.to_s.encode("UTF-8", invalid: :replace, undef: :replace)
end

def build_technology_context(primary_recipe, supporting_recipes, domains)
  parts = ["# Technology Context", ""]
  parts << "Recipe: #{str(primary_recipe["name"])} (#{str(primary_recipe["type"])})"

  fw = primary_recipe["framework"]
  if fw && !fw.empty?
    parts << ""
    parts << "Framework stack:"
    fw.each { |key, value| parts << "- #{key}: #{value}" }
  end

  if domains.any?
    parts << ""
    parts << "## Domain Context"
    domains.each do |domain|
      parts << "### #{domain["name"]}"
      parts << "Primary value: #{str(domain["primary_value"])}" if domain["primary_value"]
      if domain["terminology"]
        parts << "Terminology:"
        domain["terminology"].each { |k, v| parts << "- #{k}: #{v}" }
      end
    end
  end

  parts.join("\n")
end

technology_context = build_technology_context(primary_recipe, supporting_recipes, domains)

# Render system prompt
system_prompt = ERB.new(File.read(system_template_path, encoding: "UTF-8"), trim_mode: "-")
                     .result(binding)

# Render user prompt
user_prompt = ERB.new(File.read(user_template_path, encoding: "UTF-8"), trim_mode: "-")
                   .result(binding)

combined_prompt = "#{system_prompt}\n\n---\n\n#{user_prompt}"

# ─── Call Claude ───

$stderr.puts "  Extracting screens from spec (calling Claude)..."

claude_path = `which claude 2>/dev/null`.strip
abort "claude CLI not found" if claude_path.empty?

prompt_data = combined_prompt.encode("UTF-8", invalid: :replace, undef: :replace)

# Scan a balanced `{...}` object from position `start`. Returns
# [substring, complete?] where complete? is true when depth returned to zero
# (matching close found), false when we ran out of input mid-object. Returns
# [nil, false] if `start` isn't `{`. String-aware so braces inside quoted
# values don't confuse depth tracking.
def scan_balanced_object(text, start)
  return [nil, false] unless text[start] == "{"

  depth = 0
  in_string = false
  escaped = false
  i = start
  while i < text.length
    c = text[i]
    if in_string
      if escaped
        escaped = false
      elsif c == "\\"
        escaped = true
      elsif c == '"'
        in_string = false
      end
    else
      case c
      when '"' then in_string = true
      when "{" then depth += 1
      when "}"
        depth -= 1
        return [text[start..i], true] if depth.zero?
      end
    end
    i += 1
  end
  [text[start..-1], false] # truncated
end

# Find the best JSON-object candidate in arbitrary text — handles prose before
# the manifest, markdown fences, and unrelated `{placeholder}` tokens embedded
# in explanatory text. Tries each `{` position in order and returns the first
# candidate that parses AND looks like a screen manifest ({"screens": [...]}).
# Falls back to the largest parseable object, then to a truncated tail so the
# repair logic downstream has something to work with.
def extract_manifest_candidate(text)
  parseable = []
  truncated_tail = nil
  idx = 0
  while (start = text.index("{", idx))
    candidate, complete = scan_balanced_object(text, start)
    break unless candidate
    if complete
      begin
        parsed = JSON.parse(candidate)
        return candidate if parsed.is_a?(Hash) && parsed["screens"].is_a?(Array)
        parseable << candidate
      rescue JSON::ParserError
        # not valid JSON at this position; try the next `{`
      end
      idx = start + candidate.length
    else
      truncated_tail = candidate
      break
    end
  end
  # If the truncated tail looks manifest-shaped, prefer it over any small
  # parseable prose object we collected (those are almost certainly noise).
  return truncated_tail if truncated_tail && truncated_tail.include?('"screens"')
  parseable.max_by(&:length) || truncated_tail
end

def dump_debug(output_path, response, json_str, stderr_out, status)
  debug_dir = File.join(File.dirname(File.expand_path(output_path)), ".scaffold-debug")
  FileUtils.mkdir_p(debug_dir)
  File.write(File.join(debug_dir, "screen_extraction_response.txt"), response.to_s)
  File.write(File.join(debug_dir, "screen_extraction_extracted.txt"), json_str.to_s)
  File.write(File.join(debug_dir, "screen_extraction_stderr.txt"), stderr_out.to_s)
  File.write(File.join(debug_dir, "screen_extraction_status.txt"), "exit=#{status.exitstatus}\n")
  debug_dir
end

# Wall-clock cap on claude -p. Phase A is one large call; without a timeout
# the scaffold run stalls indefinitely if the CLI wedges. The output is a
# whole-project manifest (35+ screens for coaching10-sized specs) which can
# take real time to stream end-to-end — especially under TPM throttling or
# network hiccups — so we budget generously and rely on retries to cover
# transient failures. Observed 420s tripping on coaching10 even when the call
# was progressing, so 900s.
CLAUDE_TIMEOUT_SECONDS = 900
MAX_CLAUDE_RETRIES = 2

class ClaudeTimeoutError < StandardError; end

def call_claude_with_timeout(claude_path, prompt_data, timeout:)
  claude_env = { "CLAUDE_CODE_MAX_OUTPUT_TOKENS" => "65536" }
  # :pgroup => true makes the child a process-group leader so SIGTERM can
  # propagate to any descendants via `kill -pgid`. Without it, an orphan
  # holding the stdout pipe would block our reader thread forever on EOF.
  Open3.popen3(
    claude_env,
    claude_path, "-p",
    "--max-turns", "3",
    "--model", "sonnet",
    "--dangerously-skip-permissions",
    pgroup: true
  ) do |stdin, stdout_io, stderr_io, wait_thread|
    stdin.write(prompt_data)
    stdin.close

    # Drain stdout/stderr concurrently so the child never blocks on a full
    # pipe buffer (~64KB on macOS). A 65k-token manifest easily exceeds that,
    # and without draining, the child's write() blocks, we misread it as a
    # timeout, and kill a healthy process.
    stdout_reader = Thread.new { stdout_io.read }
    stderr_reader = Thread.new { stderr_io.read }

    if wait_thread.join(timeout).nil?
      pgid = Process.getpgid(wait_thread.pid) rescue wait_thread.pid
      Process.kill("-TERM", pgid) rescue nil
      unless wait_thread.join(5)
        Process.kill("-KILL", pgid) rescue nil
        wait_thread.join
      end
      stdout_reader.join
      stderr_reader.join
      raise ClaudeTimeoutError, "claude -p did not complete within #{timeout}s"
    end

    [stdout_reader.value, stderr_reader.value, wait_thread.value]
  end
end

stdout = ""
stderr_out = ""
status = nil
last_error = nil

(MAX_CLAUDE_RETRIES + 1).times do |attempt|
  begin
    stdout, stderr_out, status = call_claude_with_timeout(
      claude_path, prompt_data, timeout: CLAUDE_TIMEOUT_SECONDS
    )
    raise "claude -p exited #{status.exitstatus}" unless status.success?
    $stderr.puts "  Succeeded on retry #{attempt}" if attempt > 0
    break
  rescue ClaudeTimeoutError, StandardError => e
    last_error = e
    if attempt < MAX_CLAUDE_RETRIES
      $stderr.puts "  Attempt #{attempt + 1} failed (#{e.message}). Retrying..."
      sleep 2
    else
      $stderr.puts "  Error: screen extraction failed after #{MAX_CLAUDE_RETRIES + 1} attempts: #{e.message}"
      exit 1
    end
  end
end

response = stdout.strip

# Detect API error responses before treating the body as a manifest candidate.
if response.start_with?("Error:") || response.start_with?("API Error:")
  $stderr.puts "  Error: Claude API error: #{response[0..200]}"
  exit 1
end

# Handle Claude CLI envelope
begin
  envelope = JSON.parse(response)
  if envelope.is_a?(Hash) && envelope["type"] == "result" && envelope["result"]
    response = envelope["result"].strip
  end
rescue JSON::ParserError
  # Not an envelope
end

json_str = extract_manifest_candidate(response) || response

# Parse and validate
begin
  manifest = JSON.parse(json_str)
rescue JSON::ParserError => e
  # Try to repair truncated JSON
  repaired = json_str.dup
  repaired.sub!(/,\s*"[^"]*\z/, "")
  repaired.sub!(/,\s*\{[^}]*\z/, "")
  open_braces = repaired.count("{") - repaired.count("}")
  open_brackets = repaired.count("[") - repaired.count("]")
  repaired += "]" * [open_brackets, 0].max
  repaired += "}" * [open_braces, 0].max
  begin
    manifest = JSON.parse(repaired)
    $stderr.puts "  Warning: Repaired truncated JSON in screen manifest"
  rescue JSON::ParserError
    debug_dir = dump_debug(options[:output], response, json_str, stderr_out, status)
    $stderr.puts "  Error: Could not parse screen manifest: #{e.message}"
    $stderr.puts "  First 500 chars of extracted JSON: #{json_str[0..500]}"
    $stderr.puts "  Raw response + extracted JSON dumped to: #{debug_dir}"
    exit 1
  end
end

# Validate basic structure
unless manifest.is_a?(Hash) && manifest["screens"].is_a?(Array)
  debug_dir = dump_debug(options[:output], response, json_str, stderr_out, status)
  $stderr.puts "  Error: Manifest missing 'screens' array"
  $stderr.puts "  Raw response + extracted JSON dumped to: #{debug_dir}"
  exit 1
end

screen_count = manifest["screens"].size
role_count = (manifest["roles"] || []).size
entity_count = (manifest["seed_data"] || {}).keys.size

$stderr.puts "  Extracted #{screen_count} screens, #{role_count} roles, #{entity_count} data entities"

# Write output
File.write(options[:output], JSON.pretty_generate(manifest))
$stderr.puts "  Manifest written to #{options[:output]}"
