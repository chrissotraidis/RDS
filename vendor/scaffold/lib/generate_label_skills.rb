#!/usr/bin/env ruby
# encoding: utf-8
# frozen_string_literal: true

Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

# generate_label_skills.rb — Generate label-activated skills from recipe context
#
# Reads skill templates (ERB and plain markdown) from the templates directory,
# renders ERB templates with recipe section guidance matching each skill's label,
# and writes the resulting SKILL.md files to the output project's .claude/skills/.
#
# Also generates .claude/label-map.json mapping label names to skill names for
# use by build_prompt() at runtime.
#
# Usage:
#   ruby lib/generate_label_skills.rb \
#     --templates-dir templates/.claude/skills \
#     --recipe library/recipes/web_app.yml \
#     --supporting library/recipes/mobile_app.yml \
#     --output-dir /path/to/project/.claude/skills \
#     --label-map /path/to/project/.claude/label-map.json

require "yaml"
require "json"
require "erb"
require "fileutils"
require "optparse"

options = { supporting: [] }
OptionParser.new do |opts|
  opts.banner = "Usage: generate_label_skills.rb --templates-dir DIR --recipe FILE [--supporting LIST] --output-dir DIR --label-map FILE"
  opts.on("--templates-dir DIR", "Directory containing skill templates") { |v| options[:templates_dir] = v }
  opts.on("--recipe FILE", "Primary recipe YAML path") { |v| options[:recipe] = v }
  opts.on("--supporting LIST", "Comma-separated supporting recipe YAML paths") do |v|
    options[:supporting] = v.split(",").map(&:strip)
  end
  opts.on("--output-dir DIR", "Output directory for rendered skills") { |v| options[:output_dir] = v }
  opts.on("--label-map FILE", "Output path for label-map.json") { |v| options[:label_map] = v }
end.parse!

abort "Missing --templates-dir" unless options[:templates_dir]
abort "Missing --recipe" unless options[:recipe]
abort "Missing --output-dir" unless options[:output_dir]
abort "Missing --label-map" unless options[:label_map]

recipe = YAML.safe_load_file(options[:recipe], permitted_classes: [Symbol])
framework = recipe["framework"] || {}
recipe_name = recipe["name"] || "Unknown"
recipe_type = recipe["type"] || "generic"

# Load supporting recipes and merge their frameworks
supporting_recipes = options[:supporting].filter_map do |path|
  YAML.safe_load_file(path, permitted_classes: [Symbol]) if File.exist?(path)
end

# Build a map of label -> array of recipe sections that match that label.
# Includes sections from both primary and supporting recipes.
label_sections = {}
all_recipes = [recipe] + supporting_recipes
all_recipes.each do |r|
  (r["sections"] || []).each do |section|
    next unless section["phase"] == "pipeline"
    (section["labels"] || []).each do |label|
      label_sections[label] ||= []
      label_sections[label] << section
    end
  end
end

# Find all skill template directories
templates_dir = options[:templates_dir]
skill_dirs = Dir.children(templates_dir).select do |name|
  File.directory?(File.join(templates_dir, name))
end.sort

label_map = {}
skills_generated = 0

skill_dirs.each do |skill_dir|
  skill_name = skill_dir # e.g., "frontend-specialist"

  # Derive the label from the skill directory name (strip "-specialist" suffix)
  label = skill_name.sub(/-specialist$/, "")

  # Find the template file — either .erb or plain .md
  erb_path = File.join(templates_dir, skill_dir, "SKILL.md.erb")
  md_path = File.join(templates_dir, skill_dir, "SKILL.md")

  output_skill_dir = File.join(options[:output_dir], skill_dir)
  output_path = File.join(output_skill_dir, "SKILL.md")

  FileUtils.mkdir_p(output_skill_dir)

  if File.exist?(erb_path)
    # Render ERB template with recipe context
    sections = label_sections[label] || []
    template_content = File.read(erb_path, encoding: "UTF-8")
    template = ERB.new(template_content, trim_mode: "-")
    rendered = template.result(binding)
    File.write(output_path, rendered.encode("UTF-8"))
    $stderr.puts "  Rendered: #{skill_name} (#{sections.size} recipe sections matched)"
  elsif File.exist?(md_path)
    # Copy plain markdown skill as-is
    FileUtils.cp(md_path, output_path)
    $stderr.puts "  Copied: #{skill_name} (static)"
  else
    $stderr.puts "  Skipped: #{skill_name} (no SKILL.md or SKILL.md.erb found)"
    next
  end

  label_map[label] = skill_name
  skills_generated += 1
end

# Write label-map.json
FileUtils.mkdir_p(File.dirname(options[:label_map]))
File.write(options[:label_map], JSON.pretty_generate(label_map) + "\n")

$stderr.puts "Generated #{skills_generated} skills, label-map.json (#{label_map.size} entries)"
