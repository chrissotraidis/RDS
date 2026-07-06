#!/usr/bin/env ruby
# encoding: utf-8
# frozen_string_literal: true

Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

# generate_config_yml.rb — Generate config.yml from recipe verification/finalization
#
# Reads the primary recipe's verification and finalization sections, merges
# any additional checks from supporting recipes, and produces config.yml.
#
# Usage:
#   ruby lib/generate_config_yml.rb --recipe library/recipes/web_app.yml --output config.yml
#   ruby lib/generate_config_yml.rb --recipe library/recipes/web_app.yml \
#     --supporting library/recipes/mobile_app.yml --output config.yml

require "yaml"
require "optparse"

def solid_stack_check_command
  # Preserve newlines so Ruby statement boundaries survive round-trip through
  # YAML. Psych emits this as a block scalar (|), which bash interprets
  # correctly since the Ruby payload is inside single quotes.
  <<~'SH'
    bin/rails runner '
      config_files = ["config/application.rb"] + Dir.glob("config/environments/*.rb")
      config_sources = config_files.select { |path| File.exist?(path) }
        .to_h { |path| [path, File.read(path, encoding: "UTF-8")] }
      procfile = File.exist?("Procfile.dev") ? File.read("Procfile.dev", encoding: "UTF-8") : ""

      specs = {
        "queue" => {
          "config_key" => "config.solid_queue.connects_to",
          "table" => "solid_queue_recurring_tasks",
          "required" => procfile.each_line.any? { |line| line.lstrip.start_with?("queue:") } ||
            config_sources.values.any? { |body| body.include?("config.active_job.queue_adapter = :solid_queue") }
        },
        "cache" => {
          "config_key" => "config.solid_cache.connects_to",
          "table" => "solid_cache_entries",
          "required" => false
        },
        "cable" => {
          "config_key" => "config.solid_cable.connects_to",
          "table" => "solid_cable_messages",
          "required" => false
        }
      }

      checked = []

      specs.each do |name, spec|
        configured = config_sources.values.any? { |body| body.include?(spec["config_key"]) }
        required = spec["required"] || configured
        next unless required

        unless ActiveRecord::Base.configurations.configs_for(env_name: Rails.env, name: name).any?
          abort("Missing #{name} database config for #{Rails.env}; add it to config/database.yml or disable the #{name} runtime")
        end

        unless configured
          abort("Missing #{spec["config_key"]} in config/application.rb or a config/environments/*.rb file")
        end

        model = Class.new(ActiveRecord::Base) do
          self.abstract_class = true
        end
        model.connects_to database: { writing: name.to_sym }

        unless model.connection.data_source_exists?(spec["table"])
          abort("Missing #{spec["table"]} in the #{name} database for #{Rails.env}; run bin/rails db:prepare after the Solid install step")
        end

        checked << name
      end

      puts checked.empty? ? "Solid stack not enabled in development" : "Solid stack ready: #{checked.join(", ")}"
    '
  SH
end

options = { supporting: [] }
OptionParser.new do |opts|
  opts.banner = "Usage: generate_config_yml.rb --recipe FILE [--supporting FILE,...] --output FILE [--spec FILE]"
  opts.on("--recipe FILE", "Primary recipe YAML path") { |v| options[:recipe] = v }
  opts.on("--supporting LIST", "Comma-separated supporting recipe YAML paths") do |v|
    options[:supporting] = v.split(",").map(&:strip)
  end
  opts.on("--output FILE", "Output config.yml path") { |v| options[:output] = v }
  opts.on("--spec FILE", "Spec file for stack detection") { |v| options[:spec] = v }
  opts.on("--wiki DIR", "Wiki directory for bridge") { |v| options[:wiki] = v }
end.parse!

abort "Missing --recipe" unless options[:recipe]
abort "Missing --output" unless options[:output]

recipe = YAML.safe_load_file(options[:recipe], permitted_classes: [Symbol])
verification = recipe["verification"] || {}
finalization = recipe["finalization"] || {}
framework = recipe["framework"] || {}
workflow = recipe["workflow"] || {}
mcp = recipe["mcp"] || {}
supporting_native_launch_smoke = {}
boot_command = verification["boot_command"]
cleanup_command = verification["cleanup_command"]
runtime_env = (verification["runtime_env"] || {}).dup

# --- Stack detection from SPEC CONTENT (not recipe framework descriptions) ---
#
# Recipe framework sections list OPTIONS (e.g., "React Native, Flutter, or Swift").
# The spec describes what the project ACTUALLY uses. Detect stacks from the spec.
# Fall back to primary recipe framework only if no spec is provided.

spec_content = options[:spec] ? File.read(options[:spec], encoding: "UTF-8").downcase : nil

# Two-layer detection:
# Layer 1: PRIMARY recipe framework → guaranteed baseline stack (Rails, Python, etc.)
#          Only the primary recipe, never supporting recipes (they list alternatives).
# Layer 2: SPEC content → additional platform stacks (iOS, Android, etc.)
#          Specs describe what platforms to target; recipes describe what framework to build with.

primary_fw = framework.values.map { |v| v.to_s.downcase }.join(" ")
has_rails   = primary_fw.match?(/rails/)
has_node    = primary_fw.match?(/node|next\.js/)  # Only match Node-specific, not "react" (could be React Native)
has_python  = primary_fw.match?(/python|django|flask|fastapi/)
has_ios     = primary_fw.match?(/swift|swiftui|xcode|uikit/) && !primary_fw.include?("or native")
has_android = primary_fw.match?(/\bandroid\b|\bkotlin\b/) && !primary_fw.include?("or native")
has_flutter = primary_fw.match?(/\bflutter\b/) && !primary_fw.include?("or native")
has_react_native = primary_fw.match?(/\breact\s+native\b/)

if spec_content
  # Layer 2: scan spec for additional platform evidence.
  # Use framework-specific patterns — not prose words.
  # Exclude "Future Considerations" / deferred sections.
  active_spec = spec_content
    .sub(/#{Regexp.escape("future considerations")}.*\z/m, "")
    .sub(/#{Regexp.escape("## deferred")}.*?(?=\n##|\z)/m, "")

  # iOS: SwiftUI, Xcode, XCTest, UIKit, or 3+ mentions of "iOS"
  has_ios ||= active_spec.match?(/\bswiftui\b|\bxcode\b|\bxctest\b|\buikit\b|\bios\s+app\b/i) ||
              active_spec.scan(/\bios\b/i).size >= 3

  # Android: implementation terms or 3+ mentions
  has_android ||= active_spec.match?(/\bandroid\s+(app|sdk|studio)\b|\bkotlin\b|\bjetpack\s+compose\b|\bgradle\b/i) ||
                  active_spec.scan(/\bandroid\b/i).size >= 3

  # Flutter: framework usage
  has_flutter ||= active_spec.match?(/\bflutter\s+(app|widget|build|run)\b|\bdart\s+(file|class)\b|\bpubspec\.yaml\b/i)

  # Node/React: framework-specific terms (not prose "react")
  has_node ||= active_spec.match?(/\breact\s+(component|app|hook|router)\b|\bnext\.?js\b|\bvue\.?js\b|\bangular\s+(app|component)\b|\bsvelte\b|\bnode\.?js\b|\bnpm\s+(install|run)\b/i) &&
               !active_spec.match?(/\breact\s+native\b/i)

  # Python: framework usage
  has_python ||= active_spec.match?(/\bdjango\b|\bflask\b|\bfastapi\b|\bpython\s+\d/i)

  # Rails: explicit framework references (not "guardrails")
  has_rails ||= active_spec.match?(/\brails\s+\d|\brails\s+api\b|bin\/rails\b|\brails\s+new\b|\brails\s+server\b/i)

  # React Native is mobile, not Node
  if active_spec.match?(/\breact\s+native\b/i)
    has_react_native = true
    has_ios = true
    has_android = true
    has_node = false
  end
end

detected_stacks = []
detected_stacks << "rails"   if has_rails
detected_stacks << "node"    if has_node
detected_stacks << "python"  if has_python
detected_stacks << "ios"     if has_ios
detected_stacks << "android" if has_android
detected_stacks << "flutter" if has_flutter

$stderr.puts "Detected stacks: #{detected_stacks.join(", ")}" if detected_stacks.any?

# --- Build gitignore_patterns based on ALL detected stacks ---
gitignore = [".DS_Store", "*.swp", "*.swo", "*~", ".scaffold/task-details/", ".scaffold/review/"]
gitignore += ["/log/*", "/tmp/*", "/storage/*", "/.bundle", "/vendor/bundle"] if has_rails
gitignore += ["node_modules/", ".next/", "dist/", ".env.local"] if has_node
gitignore += ["__pycache__/", "*.pyc", ".venv/", "*.egg-info/"] if has_python
gitignore += ["DerivedData/", "xcuserdata/", "*.xcworkspace/xcuserdata/", "build/", "*.ipa"] if has_ios
gitignore += [".gradle/", "build/", "local.properties", "*.apk"] if has_android
gitignore += [".dart_tool/", "build/", ".flutter-plugins*"] if has_flutter

# --- Build post_merge_hooks based on ALL detected stacks ---
hooks = []

if has_rails
  hooks << {
    "name" => "Bundle lock",
    "trigger_paths" => ["Gemfile"],
    "command" => "bundle install --quiet",
    "commit_paths" => ["Gemfile.lock"],
    "commit_message" => "Update Gemfile.lock after merge"
  }
  hooks << {
    "name" => "Regenerate schema",
    "trigger_paths" => ["db/migrate/**"],
    "command" => "bin/rails db:prepare && bin/rails db:schema:dump",
    "commit_paths" => ["db/schema.rb", "db/cable_schema.rb", "db/cache_schema.rb", "db/queue_schema.rb"],
    "commit_message" => "Regenerate schema after migration merge"
  }
  hooks << {
    "name" => "File inventory",
    "trigger_paths" => ["**/*"],
    "command" => "find . -type f -not -path './.git/*' | wc -l"
  }
end

if has_node
  hooks << {
    "name" => "NPM install",
    "trigger_paths" => ["package.json"],
    "command" => "npm install --silent",
    "commit_paths" => ["package-lock.json"],
    "commit_message" => "Update package-lock.json after merge"
  }
end

if has_python
  hooks << {
    "name" => "Pip install",
    "trigger_paths" => ["requirements.txt", "pyproject.toml"],
    "command" => "pip install -r requirements.txt -q",
    "commit_paths" => []
  }
end

if has_ios
  pbxproj_cmd = 'ruby -e \'proj = Dir.glob("**/*.xcodeproj").first; exit(0) unless proj; ' \
    'pbx = File.read(File.join(proj, "project.pbxproj")); ' \
    'swifts = Dir.glob("**/*.swift").reject{|f| f.include?("DerivedData") || f.include?(".build")}; ' \
    'missing = swifts.select{|f| !pbx.include?(File.basename(f))}; ' \
    'if missing.any?; $stderr.puts "Missing from pbxproj: " + missing.join(", "); exit(1); end\''
  hooks << {
    "name" => "Xcode pbxproj sync check",
    "trigger_paths" => ["ios/**/*.swift", "**/*.swift"],
    "command" => pbxproj_cmd
  }
end

if has_flutter
  hooks << {
    "name" => "Flutter pub get",
    "trigger_paths" => ["pubspec.yaml"],
    "command" => "flutter pub get",
    "commit_paths" => ["pubspec.lock"],
    "commit_message" => "Update pubspec.lock after merge"
  }
end

# Add finalization commands as additional hooks if they look like dependency installs
(finalization["commands"] || []).each do |cmd|
  next if hooks.any? { |h| h["command"].include?(cmd.split.first) }
  # Skip if already covered by a hook
end

# --- Build verification_checks for ALL detected stacks ---
checks = []

if has_rails
  checks << {
    "name" => "Bundle install",
    "command" => "bundle install --quiet",
    "type" => "custom",
    "required" => true
  }
  checks << {
    "name" => "Boot check",
    "command" => "bin/rails runner 'ActiveRecord::Migration.check_all_pending!; puts Rails.version'",
    "type" => "boot",
    "required" => true
  }
  checks << {
    "name" => "Zeitwerk check",
    "command" => "bin/rails zeitwerk:check",
    "type" => "custom",
    "required" => true
  }
  # TD-030: catch routes.rb that references engine constants in env blocks
  # not covered by the gem's Gemfile groups. Conditional so it only runs in
  # apps that actually ship the verify script.
  checks << {
    "name" => "Gemfile groups match route envs",
    "command" => "bin/verify_gemfile_groups",
    "type" => "static",
    "required" => true,
    "conditional" => "bin/verify_gemfile_groups"
  }
  # TD-027: catch href="#" in app/views — sloppy nav layouts that didn't get
  # the nav_items local wired up. Conditional on the script being shipped.
  checks << {
    "name" => "No dead anchors in app views",
    "command" => "bin/verify_dead_anchors",
    "type" => "static",
    "required" => true,
    "conditional" => "bin/verify_dead_anchors"
  }
end

if has_ios
  # Discover Xcode project and scheme dynamically
  checks << {
    "name" => "Xcode build (iOS)",
    "command" => "xcodeproj=$(find . -name '*.xcodeproj' -not -path './.build/*' -not -path '*/DerivedData/*' | head -1) && [ -n \"$xcodeproj\" ] && xcodebuild -project \"$xcodeproj\" -scheme \"$(xcodebuild -project \"$xcodeproj\" -list 2>/dev/null | awk '/Schemes:/{found=1; next} found && NF{print; exit}' | xargs)\" -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -5",
    "type" => "compilation",
    "required" => true,
    "conditional" => "**/*.xcodeproj"
  }
end

if has_android
  checks << {
    "name" => "Android build",
    "command" => "cd android 2>/dev/null && ./gradlew assembleDebug 2>&1 | tail -5 || (cd .. && ./gradlew assembleDebug 2>&1 | tail -5)",
    "type" => "compilation",
    "required" => true
  }
end

if has_node
  checks << {
    "name" => "NPM install",
    "command" => "npm install --silent",
    "type" => "custom",
    "required" => true
  }
  checks << {
    "name" => "TypeScript check",
    "command" => "npx tsc --noEmit 2>/dev/null || true",
    "type" => "compilation",
    "required" => false
  }
end

if has_python
  checks << {
    "name" => "Python syntax check",
    "command" => "python -m py_compile $(find . -name '*.py' -not -path './.venv/*' | head -20) 2>&1",
    "type" => "compilation",
    "required" => true
  }
end

if has_flutter
  checks << {
    "name" => "Flutter analyze",
    "command" => "flutter analyze --no-fatal-infos",
    "type" => "compilation",
    "required" => true
  }
end

# Add recipe-specific verification checks
(verification["checks"] || []).each do |check|
  name = check["name"] || check["type"]
  next if checks.any? { |c| c["name"] == name }

  entry = {
    "name" => name,
    "command" => check["command"] || (check["type"] == "solid_stack" ? solid_stack_check_command : nil),
    "type" => check["type"] || "custom",
    "required" => check.fetch("required", false)
  }
  entry["conditional"] = check["conditional"] if check["conditional"]
  checks << entry.compact
end

# Add solid_stack check if Rails is detected and recipe mentions it
if has_rails && !checks.any? { |c| c["type"] == "solid_stack" }
  checks << {
    "name" => "Solid stack connections",
    "command" => solid_stack_check_command,
    "type" => "solid_stack",
    "required" => true
  }
end

# Add Procfile.dev smoke test — starts bin/dev and verifies all processes stay alive
# Only for recipes that use bin/dev (browser_ui capability implies Procfile.dev + foreman)
has_browser_ui = (workflow["capabilities"] || {})["browser_ui"] ||
                 %w[web_app landing_page generic bot_agent].include?(recipe["type"])
if has_rails && has_browser_ui
  procfile_smoke_cmd = <<~'SH'
    ruby -e '
      require "timeout"
      abort("No Procfile.dev found") unless File.exist?("Procfile.dev")
      expected = File.readlines("Procfile.dev")
        .reject { |l| l.strip.empty? || l.start_with?("#") }
        .map { |l| l.split(":").first.strip }
      pid = spawn("bin/dev", [:out, :err] => "/dev/null")
      sleep 6
      alive = begin; Process.kill(0, pid); true; rescue Errno::ESRCH; false; end
      Process.kill("TERM", pid) rescue nil
      Process.wait(pid) rescue nil
      abort("bin/dev exited within 6s — a Procfile.dev process likely crashed. Expected processes: #{expected.join(", ")}") unless alive
      puts "bin/dev stayed alive with processes: #{expected.join(", ")}"
    '
  SH
  checks << {
    "name" => "Procfile.dev smoke test",
    "command" => procfile_smoke_cmd,
    "type" => "custom",
    "required" => true,
    "conditional" => "Procfile.dev"
  }
end

# Add route smoke test for web stacks (runs after controllers exist)
if (has_rails || has_node) && !checks.any? { |c| c["name"] == "Route smoke test" }
  checks << {
    "name" => "Route smoke test",
    "command" => "bin/smoke_test",
    "type" => "smoke_test",
    "required" => true,
    "conditional" => "app/controllers/**/*.rb"
  }
end

# Add spec coverage audit (informational, not blocking)
unless checks.any? { |c| c["name"] == "Spec coverage audit" }
  checks << {
    "name" => "Spec coverage audit",
    "command" => "bin/spec_coverage",
    "type" => "coverage_audit",
    "required" => false
  }
end

# Add test suite check
test_cmd = verification["test_command"]
if test_cmd && !checks.any? { |c| c["type"] == "test_suite" }
  checks << {
    "name" => "Test suite",
    "command" => test_cmd,
    "type" => "test_suite",
    "required" => false
  }
elsif has_rails && !checks.any? { |c| c["type"] == "test_suite" }
  checks << {
    "name" => "Test suite",
    "command" => "bin/rails test",
    "type" => "test_suite",
    "required" => false
  }
end

# Merge supporting recipe checks
options[:supporting].each do |path|
  next unless File.exist?(path)
  supporting = YAML.safe_load_file(path, permitted_classes: [Symbol])
  sv = supporting["verification"] || {}
  supporting_workflow = supporting["workflow"] || {}
  supporting_native_launch_smoke.merge!(supporting_workflow["native_launch_smoke"] || {})
  runtime_env.merge!(sv["runtime_env"] || {})
  (sv["checks"] || []).each do |check|
    name = check["name"] || check["type"]
    next if checks.any? { |c| c["name"] == name }
    entry = {
      "name" => name,
      "command" => check["command"],
      "type" => check["type"] || "custom",
      "required" => check.fetch("required", false)
    }
    entry["conditional"] = check["conditional"] if check["conditional"]
    checks << entry.compact
  end
end

# Add health checks from recipe
health_checks = []
(verification["health_checks"] || []).each do |hc|
  health_checks << {
    "url" => hc["url"],
    "expected_status" => hc["expected_status"] || 200
  }
end

workflow_capabilities = (workflow["capabilities"] || {}).dup
workflow_capabilities["http_routes"] = true if has_rails || has_node || has_python
workflow_capabilities["browser_ui"] = true if recipe["type"] == "web_app" || recipe["type"] == "landing_page"
workflow_capabilities["background_work"] = true if recipe.to_s.match?(/\bqueue\b|\bbackground\b|\basync\b|\bjob\b/i)
workflow_capabilities["email_delivery"] = true if recipe.to_s.match?(/\bemail\b|\bmailer\b|\bsmtp\b/i)
workflow_capabilities["seed_data"] = true
workflow_capabilities["accessibility"] = true if workflow_capabilities["browser_ui"] || has_ios || has_android || has_flutter
workflow_capabilities["native_tests"] = true
workflow_capabilities["authn"] = true if recipe.to_s.match?(/\bauthentication\b|\blogin\b|\bpassword\b/i)
workflow_capabilities["authz"] = true if recipe.to_s.match?(/\bauthorization\b|\bpermission\b|\brole\b|\baccess control\b/i)

task_test_globs = []
task_test_globs += %w[test/**/*_test.rb spec/**/*_spec.rb] if has_rails
task_test_globs += %w[test/**/* tests/**/* __tests__/**/* cypress/e2e/**/* playwright/**/*] if has_node
task_test_globs += %w[tests/**/*.py test_*.py] if has_python
task_test_globs += %w[ios/**/*Tests*.swift **/*Tests.swift] if has_ios
task_test_globs += %w[android/**/*Test*.kt android/**/*Test*.java **/*Test.kt **/*Test.java] if has_android
task_test_globs += %w[test/**/*_test.dart integration_test/**/*] if has_flutter

browser_test_globs = []
browser_test_globs += %w[test/system/**/* spec/system/**/*] if has_rails
browser_test_globs += %w[playwright/**/* cypress/e2e/**/* tests/e2e/**/*] if has_node
browser_test_globs += %w[integration_test/**/*] if has_flutter

ui_template_globs = []
ui_template_globs += %w[app/views/**/* app/components/**/*] if has_rails
ui_template_globs += %w[src/**/*.{js,jsx,ts,tsx,vue,svelte} app/**/*.{js,jsx,ts,tsx,vue,svelte} public/**/*.html] if has_node
ui_template_globs += %w[templates/**/* **/*.html] if has_python
ui_template_globs += %w[ios/**/*.swift android/**/*.kt android/**/*.xml lib/**/*.dart] if has_ios || has_android || has_flutter

native_test_globs = []
native_test_globs += %w[ios/**/*Tests*.swift **/*Tests.swift] if has_ios
native_test_globs += %w[android/**/*Test*.kt android/**/*Test*.java **/*Test.kt **/*Test.java] if has_android
native_test_globs += %w[test/**/*_test.dart integration_test/**/*] if has_flutter

native_launch_smoke = (workflow["native_launch_smoke"] || {}).merge(supporting_native_launch_smoke)
native_launch_smoke.select! do |stack, _|
  detected_stacks.include?(stack.to_s)
end

schema_globs = []
schema_globs += %w[db/schema.rb db/migrate/**/* app/models/**/*] if has_rails
schema_globs += %w[schema.prisma prisma/**/* src/models/**/* src/db/**/*] if has_node
schema_globs += %w[**/models.py **/migrations/**/*] if has_python

code_globs = []
code_globs += %w[app/**/*.rb lib/**/*.rb config/**/*.rb] if has_rails
code_globs += %w[src/**/*.{js,jsx,ts,tsx} app/**/*.{js,jsx,ts,tsx}] if has_node
code_globs += %w[**/*.py] if has_python
code_globs += %w[ios/**/*.swift android/**/*.kt lib/**/*.dart] if has_ios || has_android || has_flutter

coverage_policy = {
  "early_mode" => "informational",
  "progress_compact" => true,
  "progress_example_limit" => 3,
  "final_fail_under" => 90,
  "enforce_on_titles" => ["UAT Walkthrough", "Final Hygiene Check"]
}

verification_adapters = {
  "http" => {
    "base_url_shell" => "${APP_BASE_URL:-http://127.0.0.1:${APP_PORT:-3000}}"
  },
  "seed_commands" => {},
  "test_runners" => {},
  "readiness_commands" => {},
  "ui_affordance" => {
    "globs_key" => "ui_template_globs",
    "ignored_terms" => %w[page screen flow user click tap]
  },
  "accessibility" => {
    "globs_key" => "ui_template_globs"
  },
  "entity_contract" => {
    "globs_key" => "schema_globs"
  },
  "native_launch" => {
    "prefer_test_runner" => true
  },
  "authz_wiring" => {
    "commands" => {}
  },
  "audit_text" => {
    "commands" => {
      "generic" => "rg -ni 'audit|activity log|security log' app lib src config >/dev/null 2>&1"
    }
  },
  "turbo_navigation" => {
    "commands" => {}
  }
}

verification_adapters["seed_commands"]["rails"] = "bin/rails db:seed" if has_rails
verification_adapters["seed_commands"]["python"] = "python manage.py loaddata demo" if has_python
verification_adapters["seed_commands"]["node"] = "npm run seed --if-present" if has_node

verification_adapters["test_runners"]["rails"] = "bin/rails test" if has_rails
if has_python
  verification_adapters["test_runners"]["python"] =
    if test_cmd.to_s.include?("pytest")
      "python -m pytest"
    else
      "python -m pytest"
    end
end
if has_node
  verification_adapters["test_runners"]["node"] =
    if test_cmd.to_s.match?(/\bvitest\b/)
      "npx vitest run"
    elsif test_cmd.to_s.match?(/\bjest\b/)
      "npx jest"
    end
end
verification_adapters["test_runners"]["flutter"] = "flutter test" if has_flutter
if has_ios
  verification_adapters["test_runners"]["ios"] =
    "xcodeproj=$(find . -name '*.xcodeproj' -not -path './.build/*' -not -path '*/DerivedData/*' | head -1) && [ -n \"$xcodeproj\" ] && xcodebuild test -project \"$xcodeproj\" -scheme \"$(xcodebuild -project \"$xcodeproj\" -list 2>/dev/null | awk '/Schemes:/{found=1; next} found && NF{print; exit}' | xargs)\" -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet 2>&1 | tail -20"
end
if has_android
  verification_adapters["test_runners"]["android"] =
    "cd android 2>/dev/null && ./gradlew testDebugUnitTest 2>&1 | tail -20 || ./gradlew testDebugUnitTest 2>&1 | tail -20"
end

if has_rails
  verification_adapters["readiness_commands"]["background_processing_ready"] ||= {}
  verification_adapters["readiness_commands"]["background_processing_ready"]["rails"] =
    %q(ruby -e 'candidates = {"Procfile.dev" => /queue:|solid_queue:start/, ".env" => /SOLID_QUEUE_IN_PUMA\s*=\s*true/, ".env.example" => /SOLID_QUEUE_IN_PUMA\s*=\s*true/, "config/puma.rb" => /solid[_ ]queue|plugin.*queue/i, "config/environments/development.rb" => /queue_adapter\s*=\s*:async/, "config/application.rb" => /solid_queue/i}; ready = candidates.any? { |path, pattern| File.exist?(path) && File.read(path, encoding: "UTF-8").match?(pattern) }; abort("Background processing is not proven ready in development") unless ready')
  verification_adapters["readiness_commands"]["email_delivery_ready"] ||= {}
  verification_adapters["readiness_commands"]["email_delivery_ready"]["rails"] =
    %q(ruby -e 'files = ["Gemfile", "config/environments/development.rb", ".env", ".env.example"]; content = files.select { |path| File.exist?(path) }.map { |path| File.read(path, encoding: "UTF-8") }.join("\n"); ready = content.match?(/letter_opener|letter_opener_web|delivery_method\s*=\s*:(file|test|smtp)/i); abort("Email delivery is not configured for local inspection") unless ready')
  verification_adapters["authz_wiring"]["commands"]["rails"] =
    %q(ruby -e 'patterns = ["app/**/*.rb", "lib/**/*.rb", "config/**/*.rb"]; files = patterns.flat_map { |pattern| Dir.glob(pattern) }.uniq.select { |path| File.file?(path) }; defs = []; files.each do |path| text = File.read(path, encoding: "UTF-8") rescue next; defs.concat(text.scan(/\bdef\s+(authorize_[a-z0-9_!?]+|require_[a-z0-9_!?]+)/).flatten); defs.concat(text.scan(/\b(?:function|const)\s+(authorize[A-Z]\w+|require[A-Z]\w+)/).flatten); end; defs.uniq!; unused = defs.select do |name| references = files.sum do |path| text = File.read(path, encoding: "UTF-8") rescue ""; text.scan(/\b#{Regexp.escape(name)}\b/).size; end; references < 2; end; abort("Authorization helpers defined but not used: #{unused.join(", ")}") unless unused.empty?')
  verification_adapters["turbo_navigation"]["commands"]["rails"] =
    %q(if rg -n 'turbo_frame_tag|data-turbo-frame|turbo-frame' app/views app/components >/dev/null 2>&1; then rg -n 'data-turbo-frame="_top"' app/views app/components >/dev/null; else true; fi)
end

if has_node
  verification_adapters["readiness_commands"]["background_processing_ready"] ||= {}
  verification_adapters["readiness_commands"]["background_processing_ready"]["node"] =
    %q(ruby -e 'require "json"; package = File.exist?("package.json") ? JSON.parse(File.read("package.json", encoding: "UTF-8")) : {}; scripts = package["scripts"] || {}; ready = scripts.keys.any? { |name| name.match?(/worker|queue|jobs?|dev/i) } || Dir.glob("Procfile*").any? { |path| File.read(path, encoding: "UTF-8").match?(/worker|queue|job/i) }; abort("Background processing is not proven ready in development") unless ready')
  verification_adapters["authz_wiring"]["commands"]["node"] =
    %q(ruby -e 'patterns = ["src/**/*.{js,jsx,ts,tsx}", "app/**/*.{js,jsx,ts,tsx}"]; files = patterns.flat_map { |pattern| Dir.glob(pattern) }.uniq.select { |path| File.file?(path) }; defs = []; files.each do |path| text = File.read(path, encoding: "UTF-8") rescue next; defs.concat(text.scan(/\b(?:function|const)\s+(authorize[A-Z]\w+|require[A-Z]\w+)/).flatten); end; defs.uniq!; unused = defs.select do |name| references = files.sum do |path| text = File.read(path, encoding: "UTF-8") rescue ""; text.scan(/\b#{Regexp.escape(name)}\b/).size; end; references < 2; end; abort("Authorization helpers defined but not used: #{unused.join(", ")}") unless unused.empty?')
end

if has_python
  verification_adapters["readiness_commands"]["background_processing_ready"] ||= {}
  verification_adapters["readiness_commands"]["background_processing_ready"]["python"] =
    %q(ruby -e 'ready = Dir.glob("Procfile*").any? { |path| File.read(path, encoding: "UTF-8").match?(/celery|rq|worker|scheduler/i) } || Dir.glob("**/*.py").any? { |path| File.read(path, encoding: "UTF-8").match?(/celery|apscheduler|rq/i) rescue false }; abort("Background processing is not proven ready in development") unless ready')
  verification_adapters["authz_wiring"]["commands"]["python"] =
    %q(ruby -e 'patterns = ["**/*.py"]; files = patterns.flat_map { |pattern| Dir.glob(pattern) }.uniq.select { |path| File.file?(path) }; defs = []; files.each do |path| text = File.read(path, encoding: "UTF-8") rescue next; defs.concat(text.scan(/\bdef\s+(authorize_[a-z0-9_!?]+|require_[a-z0-9_!?]+)/).flatten); end; defs.uniq!; unused = defs.select do |name| references = files.sum do |path| text = File.read(path, encoding: "UTF-8") rescue ""; text.scan(/\b#{Regexp.escape(name)}\b/).size; end; references < 2; end; abort("Authorization helpers defined but not used: #{unused.join(", ")}") unless unused.empty?')
end

if ui_template_globs.any?
  ui_globs_literal = ui_template_globs.inspect
  verification_adapters["accessibility"]["commands"] = {
    "generic" => "ruby -e 'patterns = #{ui_globs_literal}; files = patterns.flat_map { |pattern| Dir.glob(pattern) }.uniq.select { |path| File.file?(path) }; offenders = []; files.each do |path| text = File.read(path, encoding: \"UTF-8\") rescue next; offenders << path if text.match?(/<button\\b(?![^>]*aria-label=)[^>]*>\\s*[×✕✖]\\s*<\\/button>/i); end; abort(\"Icon-only buttons missing aria-label: \#{offenders.join(\", \")}\") unless offenders.empty?'"
  }
end

# --- Derive MCP capabilities and hints from recipe + detected stacks ---
#
# MCP (Model Context Protocol) intent declarations tell downstream tools
# (like the Agentic-Coding-Harness) what context servers a project benefits
# from. Scaffold emits capabilities (what the project needs) and hints
# (enough metadata to resolve at runtime), but NOT executable MCP config.

mcp_capabilities = (mcp["capabilities"] || []).dup
mcp_hints = (mcp["hints"] || {}).dup

if detected_stacks.any? && !mcp_capabilities.include?("docs_lookup")
  mcp_capabilities << "docs_lookup"
end

# Enrich hints from detected stacks
if mcp_capabilities.include?("database_schema")
  mcp_hints["database_schema"] ||= {}
  db_hint = mcp_hints["database_schema"]
  unless db_hint.key?("adapter")
    default_adapter = if has_rails
      "postgresql"
    elsif has_node
      "prisma"
    elsif has_python
      "django_orm"
    end
    db_hint["adapter"] = default_adapter if default_adapter
  end
  db_hint["schema_paths"] ||= []
  db_hint["migration_paths"] ||= []
  db_hint["model_paths"] ||= []

  if has_rails
    db_hint["schema_paths"] |= ["db/schema.rb"]
    db_hint["migration_paths"] |= ["db/migrate"]
    db_hint["model_paths"] |= ["app/models"]
  end
  if has_node
    db_hint["schema_paths"] |= ["prisma/schema.prisma", "src/db/schema.ts"]
    db_hint["model_paths"] |= ["src/models"]
  end
  if has_python
    db_hint["schema_paths"] |= ["**/models.py"]
    db_hint["migration_paths"] |= ["**/migrations"]
  end
end

if mcp_capabilities.include?("docs_lookup")
  mcp_hints["docs_lookup"] ||= {}
  docs_hint = mcp_hints["docs_lookup"]
  docs_hint["frameworks"] ||= []

  docs_hint["frameworks"] |= ["rails"] if has_rails
  docs_hint["frameworks"] |= ["node", "express"] if has_node
  docs_hint["frameworks"] |= ["python"] if has_python
  if has_react_native
    docs_hint["frameworks"] |= ["react_native"]
  else
    docs_hint["frameworks"] |= ["swiftui", "xcode"] if has_ios
    docs_hint["frameworks"] |= ["kotlin", "jetpack_compose"] if has_android
  end
  docs_hint["frameworks"] |= ["flutter", "dart"] if has_flutter
end

# Merge supporting recipe MCP declarations
options[:supporting].each do |path|
  next unless File.exist?(path)
  supporting = YAML.safe_load_file(path, permitted_classes: [Symbol])
  s_mcp = supporting["mcp"] || {}
  (s_mcp["capabilities"] || []).each do |cap|
    mcp_capabilities << cap unless mcp_capabilities.include?(cap)
  end
  (s_mcp["hints"] || {}).each do |key, hint|
    mcp_hints[key] ||= {}
    hint.each do |k, v|
      if v.is_a?(Array)
        mcp_hints[key][k] = ((mcp_hints[key][k] || []) | v)
      else
        mcp_hints[key][k] ||= v
      end
    end
  end
end

# --- Compose config.yml ---
config = {
  "detected_stacks" => detected_stacks,
  "workflow_capabilities" => workflow_capabilities,
  "coverage_policy" => coverage_policy,
  "verification_adapters" => verification_adapters,
  "task_test_globs" => task_test_globs.uniq,
  "browser_test_globs" => browser_test_globs.uniq,
  "native_test_globs" => native_test_globs.uniq,
  "ui_template_globs" => ui_template_globs.uniq,
  "schema_globs" => schema_globs.uniq,
  "code_globs" => code_globs.uniq,
  "gitignore_patterns" => gitignore,
  "post_merge_hooks" => hooks,
  "verification_checks" => checks
}
config["mcp_capabilities"] = mcp_capabilities.uniq unless mcp_capabilities.empty?
config["mcp_hints"] = mcp_hints unless mcp_hints.empty?
config["boot_command"] = boot_command unless boot_command.nil?
config["cleanup_command"] = cleanup_command unless cleanup_command.nil?
config["runtime_env"] = runtime_env unless runtime_env.empty?
config["native_launch_smoke"] = native_launch_smoke unless native_launch_smoke.empty?
config["health_checks"] = health_checks unless health_checks.empty?
config["wiki_bridge"] = { "wiki_dir" => options[:wiki] } if options[:wiki]

# Write with comments
File.open(options[:output], "w") do |f|
  f.puts "# config.yml — Build verification and hook configuration"
  f.puts "# Generated from recipe: #{recipe["name"]}"
  f.puts "# Single source of truth for empirical validation commands"
  f.puts "#"
  f.puts "# post_merge_hooks: run after each task commit (trigger_paths matched against changed files)"
  f.puts "# verification_checks: run before marking a task done (required=true blocks completion)"
  f.puts ""
  f.puts config.to_yaml
end

$stderr.puts "Generated #{options[:output]} (#{hooks.size} hooks, #{checks.size} checks)"
