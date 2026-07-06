#!/usr/bin/env ruby
# frozen_string_literal: true

require "minitest/autorun"
require "open3"
require "pathname"
require "tmpdir"
require "yaml"

class RailsRecipeGenerationTest < Minitest::Test
  ROOT = Pathname.new(__dir__).join("..").expand_path
  RENDER_PROMPT = ROOT.join("lib", "render_prompt.rb")
  GENERATE_CONFIG = ROOT.join("lib", "generate_config_yml.rb")
  WEB_APP_RECIPE = ROOT.join("library", "recipes", "web_app.yml")
  TASK_BREAKDOWN_TEMPLATE = ROOT.join("prompts", "task_breakdown_system.md.erb")

  def test_render_prompt_includes_solid_stack_setup
    stdout, stderr, status = Open3.capture3(
      "ruby",
      RENDER_PROMPT.to_s,
      "--template", TASK_BREAKDOWN_TEMPLATE.to_s,
      "--primary-recipe", WEB_APP_RECIPE.to_s,
      chdir: ROOT.to_s
    )

    assert status.success?, "render_prompt failed\nSTDOUT:\n#{stdout}\nSTDERR:\n#{stderr}"
    assert_includes stdout, "Solid stack setup:"
    assert_includes stdout, "local development MUST use explicit development"
    assert_includes stdout, "Solid Queue tables MUST exist"
  end

  def test_generate_config_materializes_solid_stack_command
    Dir.mktmpdir("rails-recipe-config") do |dir|
      output_path = File.join(dir, "config.yml")

      stdout, stderr, status = Open3.capture3(
        "ruby",
        GENERATE_CONFIG.to_s,
        "--recipe", WEB_APP_RECIPE.to_s,
        "--output", output_path,
        chdir: ROOT.to_s
      )

      assert status.success?, "generate_config_yml failed\nSTDOUT:\n#{stdout}\nSTDERR:\n#{stderr}"

      config = YAML.safe_load_file(output_path)
      solid_stack = Array(config["verification_checks"]).find { |check| check["type"] == "solid_stack" }

      refute_nil solid_stack, "expected a solid_stack verification check"
      refute_nil solid_stack["command"], "expected solid_stack verification to have a command"
      assert_includes solid_stack["command"], "solid_queue_recurring_tasks"
      assert_includes solid_stack["command"], "config.solid_queue.connects_to"
      assert_includes solid_stack["command"], "config/database.yml"
    end
  end
end
