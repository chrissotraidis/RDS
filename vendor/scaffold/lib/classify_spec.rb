#!/usr/bin/env ruby
# encoding: utf-8
# frozen_string_literal: true

Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

# classify_spec.rb — Classify a spec against the library taxonomy using Claude.
#
# Drop-in replacement for match_library.rb. Emits the same JSON shape:
#
#   { "primary_recipe": {"name":..,"path":..},
#     "supporting_recipes": [{"name":..,"path":..}],
#     "domains": [{"name":..,"path":..}],
#     "persona": {"name":..,"path":..} }
#
# Falls back to match_library.rb on any Claude failure (missing CLI, bad JSON,
# timeout, non-zero exit) so scaffold.sh never hard-breaks on classification.
#
# Caches by spec SHA256 to `.scaffold-classify-cache/` inside the output dir (or
# --cache-dir) so re-scaffolds don't re-call Claude on the same spec.

require "digest"
require "json"
require "open3"
require "optparse"
require "tempfile"
require "yaml"

FALLBACK_RECIPE = "generic"
FALLBACK_DOMAIN = "generic"
FALLBACK_PERSONA = "general_analyst"

options = {}
OptionParser.new do |opts|
  opts.banner = "Usage: classify_spec.rb --spec SPEC --library DIR [--cache-dir DIR]"
  opts.on("--spec FILE") { |v| options[:spec] = v }
  opts.on("--library DIR") { |v| options[:library] = v }
  opts.on("--recipe LIST") { |v| options[:recipes] = v }
  opts.on("--domain LIST") { |v| options[:domains] = v }
  opts.on("--persona NAME") { |v| options[:persona] = v }
  opts.on("--cache-dir DIR", "Cache dir (default: .scaffold-classify-cache next to spec)") { |v| options[:cache_dir] = v }
  opts.on("--no-cache", "Skip cache read/write") { options[:no_cache] = true }
end.parse!

abort "Missing --spec" unless options[:spec]
abort "Missing --library" unless options[:library]
abort "Spec file not found: #{options[:spec]}" unless File.exist?(options[:spec])
abort "Library dir not found: #{options[:library]}" unless Dir.exist?(options[:library])

spec_text = File.read(options[:spec], encoding: "UTF-8")
library_dir = options[:library]

# Any operator hint short-circuits to match_library.rb — hints are deterministic,
# the classifier only runs for pure auto-detection.
if options[:recipes] || options[:domains] || options[:persona]
  passthrough = [
    "--spec", options[:spec],
    "--library", library_dir
  ]
  passthrough += ["--recipe", options[:recipes]] if options[:recipes]
  passthrough += ["--domain", options[:domains]] if options[:domains]
  passthrough += ["--persona", options[:persona]] if options[:persona]
  matcher = File.join(File.dirname(__FILE__), "match_library.rb")
  exec("ruby", matcher, *passthrough)
end

def one_line(text, limit: 160)
  s = text.to_s.gsub(/\s+/, " ").strip
  s.length > limit ? "#{s[0, limit - 1]}…" : s
end

def load_taxonomy(dir)
  Dir.glob(File.join(dir, "*.yml")).sort.map do |path|
    key = File.basename(path, ".yml")
    data = YAML.safe_load_file(path, permitted_classes: [Symbol]) || {}
    summary = one_line(
      data["description"] ||
        data["summary"] ||
        data["emphasis"] ||
        [data["name"], data["role"]].compact.join(" — ")
    )
    [key, path, summary]
  end
end

recipes = load_taxonomy(File.join(library_dir, "recipes"))
domains = load_taxonomy(File.join(library_dir, "domain_types"))
personas = load_taxonomy(File.join(library_dir, "personas"))

recipe_map = recipes.map { |k, p, _| [k, p] }.to_h
domain_map = domains.map { |k, p, _| [k, p] }.to_h
persona_map = personas.map { |k, p, _| [k, p] }.to_h

# ─── Cache ───
spec_sha = Digest::SHA256.hexdigest(spec_text)
cache_dir = options[:cache_dir] || File.join(File.dirname(options[:spec]), ".scaffold-classify-cache")
cache_path = File.join(cache_dir, "#{spec_sha}.json")

if !options[:no_cache] && File.exist?(cache_path)
  begin
    cached = JSON.parse(File.read(cache_path, encoding: "utf-8"))
    $stderr.puts "classify_spec: cache hit (#{File.basename(cache_path)})"
    puts JSON.pretty_generate(cached)
    exit 0
  rescue JSON::ParserError
    $stderr.puts "classify_spec: cache corrupt, re-classifying"
  end
end

def fallback_to_match_library!(library_dir, spec, reason)
  $stderr.puts "classify_spec: #{reason} — falling back to match_library.rb"
  matcher = File.join(File.dirname(__FILE__), "match_library.rb")
  exec("ruby", matcher, "--spec", spec, "--library", library_dir)
end

claude_path = `which claude 2>/dev/null`.strip
if claude_path.empty?
  fallback_to_match_library!(library_dir, options[:spec], "claude CLI not on PATH")
end

def render_catalog(title, entries)
  lines = ["#{title}:"]
  entries.each { |k, _, summary| lines << "  - #{k}: #{summary}" }
  lines.join("\n")
end

prompt = <<~PROMPT
  You are classifying a software specification against a fixed library taxonomy.
  Pick the best match per dimension. Return ONLY JSON — no prose, no code fences.

  Respond with this exact shape:
  {
    "primary_recipe": "<recipe_key>",
    "supporting_recipes": ["<recipe_key>", ...],
    "domains": ["<domain_key>", ...],
    "persona": "<persona_key>",
    "confidence": {
      "primary_recipe": 0.0-1.0,
      "domains": 0.0-1.0,
      "persona": 0.0-1.0
    },
    "reasoning": "one short sentence"
  }

  Rules:
  - Keys MUST be from the catalogs below. Unknown keys will be rejected.
  - `primary_recipe` is the single best shape of the thing being built.
  - `supporting_recipes` (0-2 items) are secondary aspects. Empty array if none.
  - `domains` (1-3 items) are problem-space categories; pick the dominant ones.
  - `persona` is the coding specialist best suited to lead task decomposition.
  - Reject generic/fallback keys unless the spec is genuinely unclassifiable.

  #{render_catalog("RECIPE CATALOG", recipes)}

  #{render_catalog("DOMAIN CATALOG", domains)}

  #{render_catalog("PERSONA CATALOG", personas)}

  SPECIFICATION:

  #{spec_text}
PROMPT

$stderr.puts "classify_spec: calling claude (spec #{spec_text.bytesize} bytes, taxonomy #{recipes.size + domains.size + personas.size} items)..."

output, status = Open3.capture2(
  claude_path, "-p", "--max-turns", "1",
  stdin_data: prompt
)

unless status.success?
  fallback_to_match_library!(library_dir, options[:spec], "claude exit #{status.exitstatus}")
end

# Claude sometimes wraps JSON in code fences or adds a sentence of preamble.
# Pull the first {...} block.
json_match = output.match(/\{.*\}/m)
unless json_match
  fallback_to_match_library!(library_dir, options[:spec], "claude response had no JSON object")
end

parsed = begin
  JSON.parse(json_match[0])
rescue JSON::ParserError => e
  fallback_to_match_library!(library_dir, options[:spec], "claude response JSON parse error: #{e.message}")
end

# ─── Validate keys exist in catalogs ───
# Any invalid key on the load-bearing dimensions (primary_recipe, persona, or
# ALL domains) means the classifier's output isn't trustworthy — drop the
# whole response and hand off to the keyword matcher rather than silently
# substituting generic fallbacks that would mask the error.
primary_raw = parsed["primary_recipe"]
unless primary_raw.is_a?(String) && recipe_map.key?(primary_raw)
  fallback_to_match_library!(library_dir, options[:spec],
    "claude returned unknown primary_recipe=#{primary_raw.inspect}")
end
primary_key = primary_raw

persona_raw = parsed["persona"]
unless persona_raw.is_a?(String) && persona_map.key?(persona_raw)
  fallback_to_match_library!(library_dir, options[:spec],
    "claude returned unknown persona=#{persona_raw.inspect}")
end
persona_key = persona_raw

domain_raw = Array(parsed["domains"])
domain_keys = domain_raw.select { |k| domain_map.key?(k) }.first(3)
if domain_keys.empty?
  fallback_to_match_library!(library_dir, options[:spec],
    "claude returned no valid domains (got #{domain_raw.inspect})")
end

supporting_keys = Array(parsed["supporting_recipes"])
  .select { |k| recipe_map.key?(k) && k != primary_key }
  .first(2)

# ─── Confidence warnings ───
confidence = parsed["confidence"].is_a?(Hash) ? parsed["confidence"] : {}
[
  ["primary_recipe", primary_key, confidence["primary_recipe"]],
  ["domains",        domain_keys, confidence["domains"]],
  ["persona",        persona_key, confidence["persona"]]
].each do |label, value, conf|
  next unless conf.is_a?(Numeric)
  if conf < 0.5
    $stderr.puts "classify_spec: LOW CONFIDENCE on #{label}=#{value.inspect} (confidence=#{conf}). Override with --#{label.split("_").first} if wrong."
  end
end

reasoning = parsed["reasoning"].to_s.strip
$stderr.puts "classify_spec: #{reasoning}" unless reasoning.empty?

result = {
  "primary_recipe" => { "name" => primary_key, "path" => recipe_map[primary_key] },
  "supporting_recipes" => supporting_keys.map { |k| { "name" => k, "path" => recipe_map[k] } },
  "domains" => domain_keys.map { |k| { "name" => k, "path" => domain_map[k] } },
  "persona" => { "name" => persona_key, "path" => persona_map[persona_key] }
}

# ─── Cache write ───
unless options[:no_cache]
  require "fileutils"
  FileUtils.mkdir_p(cache_dir)
  File.write(cache_path, JSON.pretty_generate(result) + "\n")
end

puts JSON.pretty_generate(result)
