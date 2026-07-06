#!/usr/bin/env ruby
# encoding: utf-8
# frozen_string_literal: true

# Force UTF-8 defaults (some systems default to US-ASCII)
Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

# hydrate_tasks.rb — Phase B of two-phase task generation
#
# Takes skeleton tasks (title, position, deps only) and hydrates them with
# implementation details by calling Claude in focused batches, sending only
# the relevant spec sections per batch.
#
# Usage:
#   ruby lib/hydrate_tasks.rb \
#     --skeleton tasks-skeleton.json \
#     --spec spec.md \
#     --primary-recipe library/recipes/web_app.yml \
#     --supporting-recipes library/recipes/mobile_app.yml \
#     --domains library/domain_types/social.yml \
#     --output tasks.json

require "json"
require "yaml"
require "erb"
require "optparse"
require "open3"
require "tempfile"

options = { supporting_recipes: [], domains: [] }
OptionParser.new do |opts|
  opts.banner = "Usage: hydrate_tasks.rb --skeleton FILE --spec FILE --primary-recipe FILE --output FILE"
  opts.on("--skeleton FILE", "Skeleton tasks JSON") { |v| options[:skeleton] = v }
  opts.on("--spec FILE", "Specification file") { |v| options[:spec] = v }
  opts.on("--primary-recipe FILE", "Primary recipe YAML") { |v| options[:primary_recipe] = v }
  opts.on("--supporting-recipes LIST", "Comma-separated supporting recipe YAMLs") do |v|
    options[:supporting_recipes] = v.split(",").map(&:strip)
  end
  opts.on("--domains LIST", "Comma-separated domain type YAMLs") do |v|
    options[:domains] = v.split(",").map(&:strip)
  end
  opts.on("--output FILE", "Output tasks.json path") { |v| options[:output] = v }
end.parse!

%i[skeleton spec primary_recipe output].each do |key|
  abort "Missing --#{key.to_s.tr('_', '-')}" unless options[key]
end

# ─── Load inputs ───

skeletons = JSON.parse(File.read(options[:skeleton], encoding: "UTF-8"))
spec_text = File.read(options[:spec], encoding: "UTF-8")

primary_recipe = YAML.safe_load_file(options[:primary_recipe], permitted_classes: [Symbol])
supporting_recipes = options[:supporting_recipes].map do |path|
  YAML.safe_load_file(path, permitted_classes: [Symbol]) if File.exist?(path)
end.compact
domains = options[:domains].map do |path|
  YAML.safe_load_file(path, permitted_classes: [Symbol]) if File.exist?(path)
end.compact

# ─── Parse spec into sections by ## headings ───

def parse_spec_sections(text)
  sections = {}
  current_h2 = nil
  current_h3 = nil
  h2_body = []
  h3_body = []

  text.each_line do |line|
    if line.match?(/^##\s+[^#]/)
      # Save previous h3 sub-section
      if current_h3
        key = current_h2 ? "#{current_h2} > #{current_h3}" : current_h3
        sections[key] = h3_body.join
      end
      # Save previous h2 section
      sections[current_h2] = h2_body.join if current_h2

      current_h2 = line.sub(/^##\s+/, "").strip
      current_h3 = nil
      h2_body = [line]
      h3_body = []
    elsif line.match?(/^###\s+/)
      # Save previous h3 sub-section
      if current_h3
        key = current_h2 ? "#{current_h2} > #{current_h3}" : current_h3
        sections[key] = h3_body.join
      end

      current_h3 = line.sub(/^###\s+/, "").strip
      h3_body = [line]
      h2_body << line
    else
      h2_body << line
      h3_body << line if current_h3
    end
  end

  # Save final sections
  if current_h3
    key = current_h2 ? "#{current_h2} > #{current_h3}" : current_h3
    sections[key] = h3_body.join
  end
  sections[current_h2] = h2_body.join if current_h2

  # Capture preamble (text before first ##) as "Overview"
  preamble = text.split(/^##\s+[^#]/).first
  sections["Overview"] = preamble if preamble && !preamble.strip.empty?

  sections
end

spec_sections = parse_spec_sections(spec_text)

# ─── Match section_ref to spec sections ───

def find_matching_sections(section_ref, spec_sections)
  return {} if section_ref.nil? || section_ref.strip.empty?

  ref_lower = section_ref.downcase.strip
  matched = {}

  # Try exact match first
  spec_sections.each do |heading, body|
    if heading.downcase == ref_lower
      matched[heading] = body
      return matched
    end
  end

  # Try "Features > Foo" format — match on the last part
  parts = ref_lower.split(/\s*>\s*/)
  search_terms = parts.map(&:strip)

  spec_sections.each do |heading, body|
    heading_lower = heading.downcase
    if search_terms.any? { |term| heading_lower.include?(term) }
      matched[heading] = body
    end
  end

  # Try fuzzy: any word overlap
  if matched.empty?
    ref_words = ref_lower.split(/\W+/).reject { |w| w.size < 3 }
    spec_sections.each do |heading, body|
      heading_words = heading.downcase.split(/\W+/)
      overlap = ref_words & heading_words
      if overlap.size >= 1
        matched[heading] = body
      end
    end
  end

  matched
end

# ─── Build technology_context (reuse render_prompt.rb logic) ───

def str(val)
  val.to_s.encode("UTF-8", invalid: :replace, undef: :replace)
end

def technology_context_for(primary_recipe, supporting_recipes, domains)
  return "" unless primary_recipe

  parts = ["# Technology Context", ""]
  parts << "Recipe: #{str(primary_recipe["name"])} (#{str(primary_recipe["type"])})"
  parts << str(primary_recipe["description"]).strip if primary_recipe["description"]

  fw = primary_recipe["framework"]
  if fw && !fw.empty?
    parts << ""
    parts << "Framework stack:"
    fw.each { |key, value| parts << "- #{key}: #{value}" }
  end

  sections = (primary_recipe["sections"] || []).select { |s| s["phase"] == "pipeline" }
  sections.each do |section|
    parts << ""
    parts << "### #{section["name"]}"
    parts << section["description"]&.strip if section["description"]
    guidance = section["guidance"]
    if guidance&.any?
      parts << "Implementation guidance:"
      guidance.each { |g| parts << "- #{g}" }
    end
    if section["solid_stack_setup"]
      parts << "Solid stack setup:"
      parts << section["solid_stack_setup"].strip
    end
  end

  if supporting_recipes.any?
    parts << ""
    parts << "## Supporting Recipes"
    supporting_recipes.each do |sr|
      parts << "**#{sr["name"]}** — #{sr["description"]&.strip}"
    end
  end

  if domains.any?
    parts << ""
    parts << "## Domain Context"
    domains.each do |domain|
      parts << "### #{domain["name"]}"
      parts << "Primary value: #{domain["primary_value"]&.strip}" if domain["primary_value"]
      if domain["watch_for"]&.any?
        parts << "Watch for:"
        domain["watch_for"].each { |w| parts << "- #{w}" }
      end
    end
  end

  verification = primary_recipe["verification"]
  if verification
    parts << ""
    parts << "## Verification"
    parts << "- Boot: `#{verification["boot_command"]}`" if verification["boot_command"]
    parts << "- Test: `#{verification["test_command"]}`" if verification["test_command"]
  end

  parts.map { |p| p.to_s.encode("UTF-8", invalid: :replace, undef: :replace) }.join("\n")
end

technology_context = technology_context_for(primary_recipe, supporting_recipes, domains)

# ─── Load detail prompt template ───

scaffold_dir = File.expand_path("..", __dir__)
detail_template_path = File.join(scaffold_dir, "prompts", "task_detail_system.md.erb")
detail_template = ERB.new(File.read(detail_template_path, encoding: "UTF-8"), trim_mode: "-")

# ─── Group skeletons into batches ───

MAX_BATCH_SIZE = 5
MAX_RETRIES = 1

def group_by_section_ref(skeletons, max_batch)
  groups = {}
  skeletons.each do |task|
    ref = (task["section_ref"] || "").strip
    ref = "General" if ref.empty?
    groups[ref] ||= []
    groups[ref] << task
  end

  # Split large groups into sub-batches
  batches = []
  groups.each do |ref, tasks|
    tasks.each_slice(max_batch) do |batch|
      batches << { section_ref: ref, tasks: batch }
    end
  end

  batches
end

batches = group_by_section_ref(skeletons, MAX_BATCH_SIZE)
total_batches = batches.size
hydrated_count = 0
fallback_count = 0

# ─── Details map: position → detail fields ───
details = {}

# ─── Process each batch ───

def call_claude_for_batch(prompt_data)
  env = { "CLAUDE_CODE_MAX_OUTPUT_TOKENS" => "65536" }
  stdout, stderr, status = Open3.capture3(
    env,
    "claude", "-p",
    "--max-turns", "3",
    "--model", "sonnet",
    "--dangerously-skip-permissions",
    stdin_data: prompt_data
  )
  [stdout, stderr, status]
end

def parse_hydration_response(response)
  response = response.strip

  # Handle Claude CLI envelope
  begin
    envelope = JSON.parse(response)
    if envelope.is_a?(Hash) && envelope["type"] == "result" && envelope["result"]
      response = envelope["result"].strip
    end
  rescue JSON::ParserError
    # Not an envelope
  end

  # Detect API error responses
  if response.start_with?("Error:") || response.start_with?("API Error:")
    raise "Claude API error: #{response[0..200]}"
  end

  # Extract JSON from possible markdown fence
  json_str = if response.start_with?("{")
    response
  elsif response.include?("```json")
    response[/```json\s*\n(.*?)```/m, 1]
  elsif response.include?("```")
    response[/```\s*\n(.*?)```/m, 1]
  else
    response
  end

  raise "Empty response after extraction" if json_str.nil? || json_str.strip.empty?

  # Try direct parse first
  begin
    return JSON.parse(json_str)
  rescue JSON::ParserError
    # Fall through to repair
  end

  # Repair truncated JSON — progressively strip trailing incomplete structures
  repaired = json_str.dup

  # Remove trailing incomplete string value: ,"key":"partial value...
  repaired.sub!(/,\s*"[^"]*"\s*:\s*"[^"]*\z/, '')
  # Remove trailing incomplete object: ,{"key":...
  repaired.sub!(/,\s*"[^"]*"\s*:\s*\{[^}]*\z/, '')
  # Remove trailing incomplete key-value: ,"key...
  repaired.sub!(/,\s*"[^"]*\z/, '')

  # Close unmatched braces/brackets
  open_braces = repaired.count("{") - repaired.count("}")
  open_brackets = repaired.count("[") - repaired.count("]")
  repaired += "]" * [open_brackets, 0].max
  repaired += "}" * [open_braces, 0].max

  JSON.parse(repaired)
end

batches.each_with_index do |batch, idx|
  section_ref = batch[:section_ref]
  batch_tasks = batch[:tasks]
  positions = batch_tasks.map { |t| t["position"] }

  $stderr.puts "  Phase B: Hydrating batch #{idx + 1}/#{total_batches} " \
    "(tasks #{positions.join(', ')}, section: #{section_ref})..."

  # Find relevant spec sections
  matched_sections = {}
  batch_tasks.each do |task|
    ref = task["section_ref"] || ""
    find_matching_sections(ref, spec_sections).each do |heading, body|
      matched_sections[heading] = body
    end
  end

  # If no sections matched, include overview + a chunk of the full spec
  if matched_sections.empty?
    matched_sections["Overview"] = spec_sections["Overview"] || ""
    matched_sections["Spec Excerpt"] = spec_text[0..5000]
  end

  # Build spec context string (force UTF-8)
  spec_context = matched_sections.map do |heading, body|
    h = heading.to_s.encode("UTF-8", invalid: :replace, undef: :replace)
    b = body.to_s.encode("UTF-8", invalid: :replace, undef: :replace)
    "## #{h}\n#{b}"
  end.join("\n\n")

  # Cap spec context — scale inversely with batch size
  max_context = batch_tasks.size > 3 ? 20_000 : 30_000
  spec_context = spec_context[0..max_context] if spec_context.size > max_context

  # Build skeleton context
  skeleton_json = batch_tasks.map do |t|
    { position: t["position"], title: t["title"], depends_on: t["depends_on"], labels: t["labels"] }
  end

  # Render the detail prompt
  system_prompt = detail_template.result(binding)

  # Build combined prompt
  user_prompt = <<~PROMPT
    # Task Skeletons to Hydrate

    ```json
    #{JSON.generate(skeleton_json)}
    ```

    # Relevant Specification Sections

    #{spec_context}

    ---

    Produce implementation details for each task above. Return JSON keyed by position number.
  PROMPT

  combined_prompt = "#{system_prompt}\n\n---\n\n#{user_prompt}"
  prompt_data = combined_prompt.encode("UTF-8", invalid: :replace, undef: :replace)

  # Call Claude with retry
  success = false
  attempts = 0

  while !success && attempts <= MAX_RETRIES
    attempts += 1

    begin
      stdout, stderr, status = call_claude_for_batch(prompt_data)
      batch_details = parse_hydration_response(stdout)

      # Merge into details map
      batch_details.each do |pos_str, detail|
        pos = pos_str.to_i
        details[pos] = detail
        hydrated_count += 1
      end
      success = true

      if attempts > 1
        $stderr.puts "    Succeeded on retry #{attempts - 1}"
      end

    rescue => e
      if attempts <= MAX_RETRIES
        $stderr.puts "    Attempt #{attempts} failed (#{e.message}). Retrying..."
        sleep 2
      else
        $stderr.puts "    Warning: Batch #{idx + 1} failed after #{attempts} attempts (#{e.message}). Using fallback."
      end
    end
  end

  # If all attempts failed and batch has > 1 task, try splitting into individual tasks
  if !success && batch_tasks.size > 1
    $stderr.puts "    Splitting batch into #{batch_tasks.size} individual tasks..."
    batch_tasks.each do |task|
      single_skeleton = [{ position: task["position"], title: task["title"],
                           depends_on: task["depends_on"], labels: task["labels"] }]
      single_ref = task["section_ref"] || ""
      single_sections = find_matching_sections(single_ref, spec_sections)
      single_sections = { "Overview" => spec_sections["Overview"] || "" } if single_sections.empty?

      single_context = single_sections.map do |h, b|
        "## #{h}\n#{b}"
      end.join("\n\n")[0..20_000]

      single_prompt = <<~PROMPT
        #{system_prompt}

        ---

        # Task Skeletons to Hydrate

        ```json
        #{JSON.generate(single_skeleton)}
        ```

        # Relevant Specification Sections

        #{single_context}

        ---

        Produce implementation details for the task above. Return JSON keyed by position number.
      PROMPT

      begin
        stdout, _, _ = call_claude_for_batch(
          single_prompt.encode("UTF-8", invalid: :replace, undef: :replace)
        )
        single_details = parse_hydration_response(stdout)
        single_details.each do |pos_str, detail|
          details[pos_str.to_i] = detail
          hydrated_count += 1
        end
        $stderr.puts "      Task #{task["position"]} hydrated individually"
      rescue => e
        $stderr.puts "      Task #{task["position"]} failed individually (#{e.message}). Using fallback."
      end
    end
  end
end

# ─── Merge details into skeletons ───

skeletons.each do |task|
  pos = task["position"]
  if details.key?(pos)
    detail = details[pos]
    task["description"] = detail["description"] || task["title"]
    task["acceptance_criteria"] = detail["acceptance_criteria"] || []
    task["verification"] = detail["verification"] || { "commands" => [] }
    task["runbook"] = detail["runbook"] || ""
    task["user_story"] = detail["user_story"] || task["user_story"] || ""
    task["done_when"] = detail["done_when"] || task["done_when"] || ""
    task["requirement_refs"] = (Array(task["requirement_refs"]) + Array(detail["requirement_refs"])).map(&:to_s).map(&:strip).reject(&:empty?).uniq

    # Decode stringified params in acceptance_criteria
    (task["acceptance_criteria"] || []).each do |ac|
      if ac["params"].is_a?(String)
        begin
          ac["params"] = JSON.parse(ac["params"])
        rescue JSON::ParserError
          ac["params"] = {}
        end
      end
      ac["params"] ||= {}
    end
  else
    # Fallback for tasks not hydrated
    fallback_count += 1
    section = task["section_ref"] || "the specification"
    task["description"] = "Implement #{task["title"]} as described in spec section: #{section}. " \
      "Read the relevant spec section, implement the feature, and verify with the commands below."
    task["acceptance_criteria"] = [
      { "type" => "command_exits", "description" => "App boots successfully",
        "params" => { "command" => "bin/task verify", "expected_exit_code" => 0 } }
    ]
    task["verification"] = {
      "commands" => [
        { "name" => "Boot check", "command" => "bin/rails runner 'puts :OK'", "required" => true },
        { "name" => "Global verify", "command" => "bin/task verify", "required" => false }
      ]
    }
    task["runbook"] = "See spec section '#{section}' for feature details."
  end

  task["status"] = "pending"
end

# ─── Output through validate_tasks.rb for final validation ───

validate_script = File.join(scaffold_dir, "lib", "validate_tasks.rb")
tasks_json = JSON.generate(skeletons)
recipe_type_arg = primary_recipe["type"] || "generic"

stdout, stderr, status = Open3.capture3(
  "ruby", validate_script, "--recipe-type", recipe_type_arg, "--spec", options[:spec],
  stdin_data: tasks_json.encode("UTF-8", invalid: :replace, undef: :replace)
)

$stderr.print stderr unless stderr.empty?

if status.success?
  File.write(options[:output], stdout.encode("UTF-8", invalid: :replace, undef: :replace))
else
  # If validation fails, write raw merged tasks
  $stderr.puts "Warning: validate_tasks.rb failed. Writing raw merged tasks."
  File.write(options[:output], JSON.pretty_generate(skeletons))
end

$stderr.puts "  Phase B complete: #{hydrated_count} hydrated, #{fallback_count} fallback"
