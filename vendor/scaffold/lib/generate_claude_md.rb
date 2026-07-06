#!/usr/bin/env ruby
# encoding: utf-8
# frozen_string_literal: true

Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

# generate_claude_md.rb — Render CLAUDE.md from recipe, domain, persona, config, and rules
#
# Usage:
#   ruby lib/generate_claude_md.rb \
#     --spec spec.md \
#     --primary-recipe library/recipes/web_app.yml \
#     --supporting-recipes library/recipes/mobile_app.yml \
#     --domains library/domain_types/productivity.yml,library/domain_types/health.yml \
#     --persona library/personas/software_architect.yml \
#     --config config.yml \
#     --rules "extracted rules text" \
#     --output CLAUDE.md

require "yaml"
require "erb"
require "optparse"
require "json"

SOFT_CHAR_LIMIT = 20_000
HARD_CHAR_LIMIT = 30_000
MAX_SUMMARY_CHARS = 480
MAX_DOMAINS = 3
MAX_SUPPORTING_RECIPES = 2

options = { supporting_recipes: [], domains: [] }
OptionParser.new do |opts|
  opts.banner = "Usage: generate_claude_md.rb [options]"
  opts.on("--spec FILE", "Path to spec.md") { |v| options[:spec] = v }
  opts.on("--primary-recipe FILE", "Primary recipe YAML") { |v| options[:primary_recipe] = v }
  opts.on("--supporting-recipes LIST", "Comma-separated supporting recipe YAMLs") do |v|
    options[:supporting_recipes] = v.split(",").map(&:strip)
  end
  opts.on("--domains LIST", "Comma-separated domain type YAMLs") do |v|
    options[:domains] = v.split(",").map(&:strip)
  end
  opts.on("--persona FILE", "Persona YAML") { |v| options[:persona] = v }
  opts.on("--config FILE", "config.yml path") { |v| options[:config] = v }
  opts.on("--rules TEXT", "Extracted architectural rules (markdown)") { |v| options[:rules] = v }
  opts.on("--rules-file FILE", "File containing extracted rules") { |v| options[:rules_file] = v }
  opts.on("--wiki", "Wiki directory is present in the output project") { options[:has_wiki] = true }
  opts.on("--output FILE", "Output CLAUDE.md path") { |v| options[:output] = v }
end.parse!

abort "Missing --spec" unless options[:spec]
abort "Missing --primary-recipe" unless options[:primary_recipe]
abort "Missing --output" unless options[:output]

# Load data
spec_text = File.read(options[:spec], encoding: "UTF-8")
primary_recipe = YAML.safe_load_file(options[:primary_recipe], permitted_classes: [Symbol])

supporting_recipes = options[:supporting_recipes].map do |path|
  YAML.safe_load_file(path, permitted_classes: [Symbol]) if File.exist?(path)
end.compact

domains = options[:domains].map do |path|
  YAML.safe_load_file(path, permitted_classes: [Symbol]) if File.exist?(path)
end.compact

# Fallback: if no domains, use a generic placeholder
if domains.empty?
  domains = [{ "name" => "General", "emphasis" => [], "watch_for" => [], "terminology" => {} }]
end

persona = options[:persona] ? YAML.safe_load_file(options[:persona], permitted_classes: [Symbol]) : nil

# Load config.yml for verification checks
verification_checks = []
if options[:config] && File.exist?(options[:config])
  config = YAML.safe_load_file(options[:config])
  verification_checks = config["verification_checks"] || []
end

# Load architectural rules
architectural_rules = options[:rules] || ""
if options[:rules_file] && File.exist?(options[:rules_file])
  architectural_rules = File.read(options[:rules_file])
end

# Extract project name from spec (first heading)
project_name = spec_text[/^#\s+(.+)/, 1] || "Project"

def normalize_whitespace(text)
  text.to_s.gsub(/\s+/, " ").strip
end

def truncate_text(text, limit)
  normalized = normalize_whitespace(text)
  return normalized if normalized.length <= limit

  clipped = normalized[0, limit]
  clipped = clipped.sub(/\s+\S*\z/, "")
  "#{clipped.rstrip}..."
end

# Truncate at a clean phrase boundary so we never cut inside parens or mid-word.
# Prefers end-of-sentence / closing paren within the limit; otherwise falls back
# to the last boundary (comma, space) that leaves parens balanced. If no safe
# boundary exists at or below the limit, returns the full text (better to
# exceed the soft limit than emit garbled prose).
def truncate_at_boundary(text, limit)
  normalized = normalize_whitespace(text)
  return normalized if normalized.length <= limit

  window = normalized[0, limit]
  # Best boundary: end of a closing paren or sentence punctuation.
  %w[) . ! ?].each do |punct|
    idx = window.rindex(punct)
    if idx && paren_balanced?(window[0..idx])
      return window[0..idx].rstrip
    end
  end

  # Next best: a comma or space, but only if parens are balanced there.
  [",", " "].each do |sep|
    idx = window.rindex(sep)
    while idx
      candidate = window[0, idx].rstrip
      return "#{candidate}..." if paren_balanced?(candidate) && !candidate.empty?

      idx = window.rindex(sep, idx - 1) if idx.positive?
      break if idx.nil? || idx <= 0
    end
  end

  # No safe cut point found — emit the full value rather than truncating mid-token.
  normalized
end

def paren_balanced?(text)
  text.count("(") == text.count(")")
end

def first_meaningful_paragraph(spec_text)
  paragraphs = spec_text.split(/\n{2,}/).map(&:strip).reject(&:empty?)

  # Prefer an opening blockquote (often a one-line user description at the top).
  leading_blockquote = paragraphs.first
  if leading_blockquote && leading_blockquote.start_with?(">")
    cleaned = leading_blockquote.lines.map { |l| l.sub(/^>\s?/, "") }.join(" ").strip
    return cleaned unless cleaned.empty?
  end

  lines = spec_text.lines
  title_index = lines.index { |line| line.match?(/^#\s+/) } || -1
  body_paragraphs = lines[(title_index + 1)..].to_a.join.split(/\n{2,}/).map(&:strip)

  # Skip headings, bullet-list blocks, code fences, and obvious metadata echoes.
  body_paragraphs.find do |para|
    next false if para.empty?
    next false if para =~ /^#+\s/
    next false if para =~ /^[-*+]\s/        # bullet list block
    next false if para.start_with?("```")   # code fence
    next false if para =~ /^Application\s+Classification\s*:/i
    true
  end
end

def summarize_recipe(recipe)
  parts =
    (recipe["framework"] || {})
      .first(3)
      .map { |key, value| "#{key}: #{truncate_at_boundary(value, 60)}" }
  return recipe["name"].to_s if parts.empty?

  "#{recipe["name"]} (#{parts.join(", ")})"
end

def summarize_domain(domain)
  base = domain["name"].to_s
  primary_value = normalize_whitespace(domain["primary_value"])
  return base if primary_value.empty?

  "#{base} — #{truncate_text(primary_value, 80)}"
end

trimmed_sections = []

summary_source = first_meaningful_paragraph(spec_text)
spec_summary =
  if summary_source && !summary_source.empty?
    truncate_text(summary_source, MAX_SUMMARY_CHARS)
  else
    "See spec.md for the full project specification and behavior details."
  end

primary_stack_lines =
  (primary_recipe["framework"] || {}).map do |key, value|
    "#{key.capitalize}: #{value}"
  end

supporting_stack_lines = supporting_recipes.first(MAX_SUPPORTING_RECIPES).map { |recipe| summarize_recipe(recipe) }
trimmed_sections << "supporting recipe detail" if supporting_recipes.size > MAX_SUPPORTING_RECIPES

domain_summaries = domains.first(MAX_DOMAINS).map { |domain| summarize_domain(domain) }
trimmed_sections << "domain detail" if domains.size > MAX_DOMAINS

verification_check_names =
  verification_checks.first(8).map do |check|
    name = check["name"] || check["type"] || "unnamed check"
    check["required"] ? "#{name} (required)" : name
  end
trimmed_sections << "full verification command list" if verification_checks.size > 8

has_wiki = options[:has_wiki] || false

# Render ERB template
template_path = File.join(File.dirname(__FILE__), "..", "templates", "CLAUDE.md.erb")
template = ERB.new(File.read(template_path, encoding: "UTF-8"), trim_mode: "-")

render = lambda do |compact: false|
  local_spec_summary =
    if compact
      "See spec.md for the full project specification and behavior details."
    else
      spec_summary
    end
  local_supporting_stack_lines = compact ? [] : supporting_stack_lines
  local_domain_summaries = compact ? [] : domain_summaries
  local_verification_check_names = verification_check_names
  local_trimmed_sections = trimmed_sections.dup
  local_trimmed_sections << "project summary" if compact
  local_trimmed_sections << "supporting technologies" if compact && supporting_stack_lines.any?
  local_trimmed_sections << "domain summaries" if compact && domain_summaries.any?

  spec_summary = local_spec_summary
  supporting_stack_lines = local_supporting_stack_lines
  domain_summaries = local_domain_summaries
  verification_check_names = local_verification_check_names
  trimmed_sections = local_trimmed_sections.uniq

  template.result(binding).encode("UTF-8", invalid: :replace, undef: :replace)
end

result = render.call(compact: false)
if result.length > HARD_CHAR_LIMIT
  result = render.call(compact: true)
end

if result.length > SOFT_CHAR_LIMIT
  trimmed_sections << "extra inline context for size budget"
end

File.write(options[:output], result)
message = "Generated #{options[:output]} (#{result.lines.size} lines, #{result.length} chars)"
if result.length > HARD_CHAR_LIMIT
  message += " [still above hard limit #{HARD_CHAR_LIMIT}]"
elsif result.length > SOFT_CHAR_LIMIT
  message += " [above soft target #{SOFT_CHAR_LIMIT}]"
end
$stderr.puts message
