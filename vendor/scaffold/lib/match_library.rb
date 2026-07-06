#!/usr/bin/env ruby
# encoding: utf-8
# frozen_string_literal: true

Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

# match_library.rb — Keyword-based library matcher
#
# Ported from Arnold's Library::Manager. Tokenizes spec content and scores
# keyword hits against recipe, domain_type, and persona YAML files.
#
# Usage:
#   ruby lib/match_library.rb --spec spec.md --library ./library
#   ruby lib/match_library.rb --spec spec.md --library ./library --recipe web_app,mobile_app --domain productivity,health
#
# Output: JSON with primary_recipe, supporting_recipes, domains, persona

require "yaml"
require "json"
require "optparse"

FALLBACK_RECIPE = "generic"
FALLBACK_DOMAIN = "generic"
FALLBACK_PERSONA = "general_analyst"

options = {}
OptionParser.new do |opts|
  opts.banner = "Usage: match_library.rb --spec SPEC --library DIR [--recipe R1,R2] [--domain D1,D2]"
  opts.on("--spec FILE", "Path to spec.md") { |v| options[:spec] = v }
  opts.on("--library DIR", "Path to library directory") { |v| options[:library] = v }
  opts.on("--recipe LIST", "Comma-separated recipe hints (first is primary)") { |v| options[:recipes] = v.split(",").map(&:strip) }
  opts.on("--domain LIST", "Comma-separated domain hints") { |v| options[:domains] = v.split(",").map(&:strip) }
  opts.on("--persona NAME", "Persona hint") { |v| options[:persona] = v.strip }
end.parse!

abort "Missing --spec" unless options[:spec]
abort "Missing --library" unless options[:library]
abort "Spec file not found: #{options[:spec]}" unless File.exist?(options[:spec])
abort "Library dir not found: #{options[:library]}" unless Dir.exist?(options[:library])

spec_text = File.read(options[:spec], encoding: "UTF-8")
library_dir = options[:library]

def tokenize(text)
  text.encode("UTF-8", invalid: :replace, undef: :replace).downcase.scan(/[a-z0-9]+/)
end

def load_yamls(dir)
  Dir.glob(File.join(dir, "*.yml")).map do |path|
    key = File.basename(path, ".yml")
    data = YAML.safe_load_file(path, permitted_classes: [Symbol])
    [key, data.merge("_path" => path)]
  end.to_h
end

def score_items(items, input_words)
  items.map do |key, data|
    keywords = (data["keywords"] || []).map(&:downcase)
    score = keywords.count { |kw| input_words.include?(kw) }
    [key, data, score]
  end.sort_by { |_, _, s| -s }
end

input_words = tokenize(spec_text)

# --- Recipes ---
recipes = load_yamls(File.join(library_dir, "recipes"))

if options[:recipes]
  # Explicit: first is primary, rest are supporting
  explicit = options[:recipes]
  primary_key = explicit.first
  abort "Recipe not found: #{primary_key}" unless recipes[primary_key]

  primary_recipe = { "path" => recipes[primary_key]["_path"], "name" => primary_key }
  supporting = explicit[1..].select { |k| recipes[k] }.map do |k|
    { "path" => recipes[k]["_path"], "name" => k }
  end
else
  # Auto-detect via keyword scoring
  scored = score_items(recipes, input_words)
  if scored.empty? || scored.first[2] == 0
    fallback = recipes[FALLBACK_RECIPE] || recipes.values.first
    primary_recipe = { "path" => fallback["_path"], "name" => FALLBACK_RECIPE }
    supporting = []
  else
    primary_recipe = { "path" => scored.first[1]["_path"], "name" => scored.first[0] }
    # Supporting: score >= half of primary's score, and score > 0
    threshold = (scored.first[2] / 2.0).ceil
    supporting = scored[1..].select { |_, _, s| s >= threshold && s > 0 }.map do |key, data, _|
      { "path" => data["_path"], "name" => key }
    end
  end
end

# --- Domain Types ---
domain_types = load_yamls(File.join(library_dir, "domain_types"))

if options[:domains]
  # Explicit domains
  domains = options[:domains].select { |k| domain_types[k] }.map do |k|
    { "path" => domain_types[k]["_path"], "name" => k }
  end
  if domains.empty?
    fallback = domain_types[FALLBACK_DOMAIN] || domain_types.values.first
    domains = [{ "path" => fallback["_path"], "name" => FALLBACK_DOMAIN }]
  end
else
  # Auto-detect: return top + any close runners-up (within 70% of top score)
  scored = score_items(domain_types, input_words)
  if scored.empty? || scored.first[2] == 0
    fallback = domain_types[FALLBACK_DOMAIN] || domain_types.values.first
    domains = [{ "path" => fallback["_path"], "name" => FALLBACK_DOMAIN }]
  else
    top_score = scored.first[2]
    threshold = (top_score * 0.7).ceil
    domains = scored.select { |_, _, s| s >= threshold && s > 0 }.map do |key, data, _|
      { "path" => data["_path"], "name" => key }
    end
    # Cap at 3 domains max for auto-detect
    domains = domains.first(3)
  end
end

# --- Personas ---
personas = load_yamls(File.join(library_dir, "personas"))

if options[:persona]
  key = options[:persona]
  abort "Persona not found: #{key}" unless personas[key]
  persona = { "path" => personas[key]["_path"], "name" => key }
else
  scored = score_items(personas, input_words)
  if scored.empty? || scored.first[2] == 0
    fallback = personas[FALLBACK_PERSONA] || personas.values.first
    persona = { "path" => fallback["_path"], "name" => FALLBACK_PERSONA }
  else
    persona = { "path" => scored.first[1]["_path"], "name" => scored.first[0] }
  end
end

result = {
  "primary_recipe" => primary_recipe,
  "supporting_recipes" => supporting,
  "domains" => domains,
  "persona" => persona
}

puts JSON.pretty_generate(result)
