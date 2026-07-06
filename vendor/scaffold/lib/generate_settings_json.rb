#!/usr/bin/env ruby
# encoding: utf-8
# frozen_string_literal: true

Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

# generate_settings_json.rb — Generate .claude/settings.json from recipe
#
# Usage:
#   ruby lib/generate_settings_json.rb --recipe library/recipes/web_app.yml --output .claude/settings.json

require "yaml"
require "json"
require "optparse"

options = {}
OptionParser.new do |opts|
  opts.banner = "Usage: generate_settings_json.rb --recipe FILE --output FILE"
  opts.on("--recipe FILE", "Primary recipe YAML path") { |v| options[:recipe] = v }
  opts.on("--output FILE", "Output settings.json path") { |v| options[:output] = v }
end.parse!

abort "Missing --recipe" unless options[:recipe]
abort "Missing --output" unless options[:output]

recipe = YAML.safe_load_file(options[:recipe], permitted_classes: [Symbol])
primary_stack = (recipe.dig("framework", "primary") || "").downcase

# Base permissions every project needs
bash_allow = [
  "git *",
  "cat *", "ls *", "mkdir *", "cp *", "mv *", "rm *", "touch *",
  "head *", "tail *", "grep *", "find *", "sed *", "awk *", "wc *",
  "chmod *", "echo *", "test *", "true", "false"
]

bash_deny = [
  "curl *", "wget *", "sudo *"
]

# Add framework-specific permissions
if primary_stack.include?("rails")
  bash_allow += [
    "bin/rails *", "bin/setup", "bin/dev", "bin/task *",
    "bundle *", "gem *", "ruby *", "rake *",
    "foreman *", "overmind *",
    "yarn *", "npx *"
  ]
elsif primary_stack.include?("node") || primary_stack.include?("next") || primary_stack.include?("react")
  bash_allow += [
    "npm *", "npx *", "yarn *", "pnpm *",
    "node *", "bin/task *",
    "next *"
  ]
elsif primary_stack.include?("python") || primary_stack.include?("django") || primary_stack.include?("flask")
  bash_allow += [
    "python *", "pip *", "pipenv *", "poetry *",
    "bin/task *", "manage.py *",
    "pytest *", "mypy *", "ruff *"
  ]
elsif primary_stack.include?("go")
  bash_allow += [
    "go *", "bin/task *",
    "make *"
  ]
else
  # Generic: allow common build tools
  bash_allow += [
    "bin/task *", "make *",
    "bundle *", "npm *", "python *", "go *"
  ]
end

settings = {
  "permissions" => {
    "allow" => [
      "Bash(#{bash_allow.join(",")})",
      "Read(**)",
      "Write(**)",
      "Edit(**)"
    ],
    "deny" => [
      "Bash(#{bash_deny.join(",")})"
    ]
  },
  "hooks" => {
    "Stop" => [
      {
        "hooks" => [
          {
            "type" => "command",
            "command" => "$CLAUDE_PROJECT_DIR/.claude/hooks/stop-gate.sh"
          }
        ]
      }
    ],
    "PreToolUse" => [
      {
        "matcher" => "Edit|Write|MultiEdit",
        "hooks" => [
          {
            "type" => "command",
            "command" => "$CLAUDE_PROJECT_DIR/.claude/hooks/context-guard.sh"
          }
        ]
      }
    ]
  }
}

File.write(options[:output], JSON.pretty_generate(settings) + "\n")
$stderr.puts "Generated #{options[:output]}"
