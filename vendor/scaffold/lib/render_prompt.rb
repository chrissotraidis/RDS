#!/usr/bin/env ruby
# encoding: utf-8
# frozen_string_literal: true

Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

# render_prompt.rb — Render ERB prompt templates with recipe/domain context
#
# Usage:
#   ruby lib/render_prompt.rb \
#     --template prompts/task_breakdown_system.md.erb \
#     --primary-recipe library/recipes/web_app.yml \
#     --supporting-recipes library/recipes/mobile_app.yml \
#     --domains library/domain_types/productivity.yml
#
#   ruby lib/render_prompt.rb \
#     --template prompts/task_breakdown_user.md.erb \
#     --spec spec.md

require "yaml"
require "erb"
require "optparse"
require_relative "wiki_enricher"

options = { supporting_recipes: [], domains: [] }
OptionParser.new do |opts|
  opts.banner = "Usage: render_prompt.rb --template FILE [options]"
  opts.on("--template FILE", "ERB template path") { |v| options[:template] = v }
  opts.on("--primary-recipe FILE", "Primary recipe YAML") { |v| options[:primary_recipe] = v }
  opts.on("--supporting-recipes LIST", "Comma-separated supporting recipe YAMLs") do |v|
    options[:supporting_recipes] = v.split(",").map(&:strip)
  end
  opts.on("--domains LIST", "Comma-separated domain type YAMLs") do |v|
    options[:domains] = v.split(",").map(&:strip)
  end
  opts.on("--spec FILE", "Spec file (for user prompt template)") { |v| options[:spec] = v }
  opts.on("--wiki DIR", "Wiki directory for enrichment context") { |v| options[:wiki] = v }
end.parse!

abort "Missing --template" unless options[:template]

# Load recipe data
primary_recipe = options[:primary_recipe] ? YAML.safe_load_file(options[:primary_recipe], permitted_classes: [Symbol]) : nil

supporting_recipes = options[:supporting_recipes].map do |path|
  YAML.safe_load_file(path, permitted_classes: [Symbol]) if File.exist?(path)
end.compact

domains = options[:domains].map do |path|
  YAML.safe_load_file(path, permitted_classes: [Symbol]) if File.exist?(path)
end.compact

# Load spec content
spec_content = options[:spec] ? File.read(options[:spec], encoding: "UTF-8") : ""

# --- Build technology_context section for system prompt ---
def str(val)
  val.to_s.encode("UTF-8", invalid: :replace, undef: :replace)
end

def technology_context_for(primary_recipe, supporting_recipes, domains)
  return "" unless primary_recipe

  parts = ["# Technology Context", ""]
  parts << "Recipe: #{str(primary_recipe["name"])} (#{str(primary_recipe["type"])})"
  parts << str(primary_recipe["description"]).strip if primary_recipe["description"]

  # Framework
  fw = primary_recipe["framework"]
  if fw && !fw.empty?
    parts << ""
    parts << "Framework stack:"
    fw.each { |key, value| parts << "- #{key}: #{value}" }
  end

  # Pipeline sections with guidance
  sections = (primary_recipe["sections"] || []).select { |s| s["phase"] == "pipeline" }
  sections.each do |section|
    parts << ""
    parts << "### #{section["name"]}"
    parts << section["description"]&.strip if section["description"]

    tools = section["rails_tools"] || section["tools"]
    if tools&.any?
      parts << ""
      parts << "Tools:"
      tools.each { |t| parts << "- #{t}" }
    end

    guidance = section["guidance"]
    if guidance&.any?
      parts << ""
      parts << "Implementation guidance:"
      guidance.each { |g| parts << "- #{g}" }
    end

    if section["solid_stack_setup"]
      parts << ""
      parts << "Solid stack setup:"
      parts << section["solid_stack_setup"].strip
    end
  end

  # Supporting recipes
  if supporting_recipes.any?
    parts << ""
    parts << "## Supporting Recipes"
    parts << "Consider these additional recipe concerns when creating tasks:"
    supporting_recipes.each do |sr|
      section_names = (sr["sections"] || []).map { |s| s["name"] }.join(", ")
      parts << ""
      parts << "**#{sr["name"]}** — #{sr["description"]&.strip}"
      parts << "Sections: #{section_names}" unless section_names.empty?
    end
  end

  # Domain context
  if domains.any?
    parts << ""
    parts << "## Domain Context"
    domains.each do |domain|
      parts << ""
      parts << "### #{domain["name"]}"
      parts << "Primary value: #{domain["primary_value"]&.strip}" if domain["primary_value"]

      if domain["emphasis"]&.any?
        parts << "Priorities:"
        domain["emphasis"].each { |e| parts << "- #{e}" }
      end

      if domain["watch_for"]&.any?
        parts << "Watch for:"
        domain["watch_for"].each { |w| parts << "- #{w}" }
      end

      if domain["terminology"]&.any?
        parts << "Terminology:"
        domain["terminology"].each { |from, to| parts << "- #{from} → #{to}" }
      end
    end
  end

  # Verification context
  verification = primary_recipe["verification"]
  if verification && !verification.empty?
    parts << ""
    parts << "## Verification"
    parts << "After all tasks complete, the project should be verifiable with:"

    (verification["setup_commands"] || []).each { |cmd| parts << "- Setup: `#{cmd}`" }
    parts << "- Boot: `#{verification["boot_command"]}`" if verification["boot_command"]

    (verification["health_checks"] || []).each do |check|
      parts << "- Health check: `#{check["url"]}` (expected #{check["expected_status"] || 200})"
    end

    parts << "- Test: `#{verification["test_command"]}`" if verification["test_command"]
    parts << ""
    parts << "Ensure the bootstrap task produces a project that passes these verification steps."
  end

  # UI Kit context — include agent instructions if recipe has a ui_kit section
  ui_kit = primary_recipe["ui_kit"]
  if ui_kit
    parts << ""
    parts << "## UI Kit (Composable UI Library)"
    parts << ""
    parts << "This project includes a vendored UI component library at `#{ui_kit["engine_path"]}`."
    parts << "It is a Rails Engine with composable ERB partials organized in four tiers:"
    (ui_kit["tiers"] || {}).each do |tier, desc|
      parts << "- **#{tier}**: #{desc}"
    end
    if ui_kit["critical_rule"]
      parts << ""
      parts << "**CRITICAL RULE:** #{ui_kit["critical_rule"].strip}"
    end
    if ui_kit["helpers"]&.any?
      parts << ""
      parts << "Helper usage examples:"
      ui_kit["helpers"].each { |h| parts << "- `#{h}`" }
    end
    if ui_kit["dependencies"]&.any?
      parts << ""
      parts << "CSS dependencies (already included in the template):"
      ui_kit["dependencies"].each { |d| parts << "- #{d}" }
    end

    # Try to load the full AGENT_INSTRUCTIONS.md for detailed guidance
    agent_instructions_path = ui_kit["agent_instructions"]
    if agent_instructions_path
      template = primary_recipe["template"] || {}
      local_path = template["local_path"].to_s.sub("~", ENV["HOME"] || "~")
      instructions_file = nil
      unless local_path.empty?
        candidate = File.join(local_path, agent_instructions_path)
        instructions_file = candidate if File.exist?(candidate)
      end
      if instructions_file
        parts << ""
        parts << "### Full Agent Instructions (from #{agent_instructions_path})"
        parts << ""
        parts << File.read(instructions_file, encoding: "UTF-8").strip
      end
    end
  end

  # Template context — inform task generation about the bootstrap approach
  template = primary_recipe["template"]
  if template
    parts << ""
    parts << "## Project Template"
    parts << ""
    parts << "This project is bootstrapped from a pre-built template, NOT from `rails new`."
    parts << "Git URL: #{template["git_url"]}" if template["git_url"]
    parts << template["description"].strip if template["description"]
    if template["includes"]&.any?
      parts << "Template includes:"
      template["includes"].each { |i| parts << "- #{i}" }
    end
    parts << ""
    parts << "The bootstrap task (position 0) MUST clone this template into the project"
    parts << "directory and customize it (rename module, update database names, install"
    parts << "dependencies, prepare database). Do NOT use `rails new`."
  end

  parts << ""
  parts << "Use these tools, gems, generators, and framework patterns when writing task descriptions."
  parts.map { |p| p.to_s.encode("UTF-8", invalid: :replace, undef: :replace) }.join("\n")
end

technology_context = technology_context_for(primary_recipe, supporting_recipes, domains)

# Build wiki enrichment context
wiki_context = if options[:wiki] && File.directory?(options[:wiki])
  WikiEnricher.new(options[:wiki]).to_prompt_context
else
  ""
end

# Render template
template_content = File.read(options[:template], encoding: "UTF-8")
template = ERB.new(template_content, trim_mode: "-")
result = template.result(binding)
$stdout.write(result.encode("UTF-8"))
